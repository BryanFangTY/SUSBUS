/*
 * SUSBUS 校园巴士实时系统 — 车辆实时位置地图模块
 * 渲染逻辑移植自 sustech.online/transport/bustimer.html（bus-v2 组件）：
 * 数据源 buseta.sustcra.com、PMTiles 深色底图、站点/线路配色、
 * 车辆朝向预测（点到线段最近距离 + 局部米制投影）、平滑移动动画。
 */
'use strict';

/* ======================= 配置 ======================= */
const API_BASE = 'https://buseta.sustcra.com';
const DARK_STYLE = 'https://bus.sustcra.com/static/protomaps/pmtiles-style/pmtiles-dark.json';
const CAMPUS_CENTER = [113.99373, 22.60308];
const REFRESH_SECONDS = 10;
const CACHE_BUST = Date.now();

/* ======================= 状态 ======================= */
const state = {
  routes: [],
  stops: [],
  vehicles: [],
  loading: true,
  error: false,
  showAllVehicles: false,
  avoidOverlap: true,
  selectedVehicle: null,
};

let maplibregl = null; // 地图库（动态加载，缺失时自动降级）
let map = null;
let mapLoaded = false;
let mapEventsBound = false;
let vehicleMarkers = new Map();
let vehicleDetailMarker = null;
let activePopup = null;
let remaining = REFRESH_SECONDS;

/* ======================= DOM ======================= */
const el = {
  splash: document.getElementById('splash'),
  map: document.getElementById('map'),
  mapMessage: document.getElementById('mapMessage'),
  vehiclesState: document.getElementById('vehiclesState'),
  lastUpdated: document.getElementById('lastUpdated'),
  toggleAllVehicles: document.getElementById('toggleAllVehicles'),
  toggleAvoidOverlap: document.getElementById('toggleAvoidOverlap'),
  refreshBtn: document.getElementById('refreshBtn'),
  refreshRing: document.querySelector('.bus-refresh-button .value'),
};

/* ======================= 工具函数（移植自 bus-v2-helpers.mjs / core.mjs） ======================= */
function parseGeometry(value) {
  try {
    const coordinates = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(coordinates) && coordinates
      .filter((point) => Array.isArray(point) && Number.isFinite(+point[0]) && Number.isFinite(+point[1]))
      .map(([longitude, latitude]) => [+longitude, +latitude]);
  } catch { return []; }
}

function displayName(item) {
  return item?.name_zh || item?.display_name_zh || item?.name_en || item?.display_name_en || '';
}

function displayStopName(stop) {
  const name = displayName(stop);
  const group = stop?.group_name_zh || stop?.group_name_en || '';
  return group && group !== name ? `${group} ${name}` : name || group;
}

function haversineMeters(latitude1, longitude1, latitude2, longitude2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 点到线段最近距离投影（局部米制投影，提升方向预测精度）
function lineProjection(coordinates, longitude, latitude, startProgress = 0, endProgress = Infinity) {
  if (!Array.isArray(coordinates) || !Number.isFinite(longitude) || !Number.isFinite(latitude) || coordinates.length < 2) return null;
  const scale = Math.cos(latitude * Math.PI / 180);
  let routeProgress = 0, nearest;
  for (let index = 1; index < coordinates.length; index++) {
    const start = coordinates[index - 1], end = coordinates[index];
    if (![start, end].every((point) => Number.isFinite(+point?.[0]) && Number.isFinite(+point?.[1]))) continue;
    const dx = (+end[0] - +start[0]) * scale, dy = +end[1] - +start[1], length = dx ** 2 + dy ** 2;
    if (!length) continue;
    const fraction = Math.max(0, Math.min(1, (((longitude - +start[0]) * scale) * dx + (latitude - +start[1]) * dy) / length));
    const segmentLength = haversineMeters(+start[1], +start[0], +end[1], +end[0]);
    const candidateProgress = routeProgress + segmentLength * fraction;
    if (candidateProgress >= startProgress && candidateProgress <= endProgress &&
        routeProgress + segmentLength > startProgress && routeProgress < endProgress) {
      const distance = ((longitude - (+start[0] + (+end[0] - +start[0]) * fraction)) * scale) ** 2 +
        (latitude - (+start[1] + (+end[1] - +start[1]) * fraction)) ** 2;
      if (!nearest || distance < nearest.distance) nearest = { distance, dx, dy, progress: candidateProgress };
    }
    routeProgress += segmentLength;
  }
  return nearest;
}

function lineBearingAt(coordinates, longitude, latitude, startProgress = 0, endProgress = Infinity) {
  const nearest = lineProjection(coordinates, longitude, latitude, startProgress, endProgress);
  return nearest ? Math.atan2(nearest.dx, nearest.dy) * 180 / Math.PI : 0;
}

function positionStopIndex(stops, position) {
  const nextNumber = Number(position?.next_stop_num);
  const sequenceIndex = Number.isFinite(nextNumber) ? stops.findIndex((stop) => Number(stop.sequence) === nextNumber) : -1;
  return sequenceIndex >= 0 ? sequenceIndex : stops.findIndex((stop) => stop.id === position?.next_stop_id);
}

// 车辆行驶方向：优先用当前位置在相邻站点间的投影，退回 heading，最后用全线投影
function vehicleBearingAt(coordinates, stops, vehicle) {
  const position = vehicle?.current_position;
  const fallback = () => lineBearingAt(coordinates, +vehicle?.longitude, +vehicle?.latitude);
  if (!position || !Array.isArray(stops) || stops.length < 2) return fallback();
  const nextIndex = positionStopIndex(stops, position);
  if (nextIndex < 0) return fallback();
  const leftIndex = position.type === 'between_stops' ? nextIndex - 1 : Math.min(nextIndex, stops.length - 2);
  if (leftIndex < 0) return fallback();
  const total = coordinates.slice(1).reduce(
    (sum, point, index) => sum + haversineMeters(+coordinates[index][1], +coordinates[index][0], +point[1], +point[0]), 0);
  const progress = [];
  for (const stop of stops) {
    progress.push(lineProjection(coordinates, +stop.longitude, +stop.latitude, progress.at(-1) ?? 0, total)?.progress ?? progress.at(-1) ?? 0);
  }
  const nearest = lineProjection(coordinates, +vehicle.longitude, +vehicle.latitude, progress[leftIndex], progress[leftIndex + 1]);
  if (nearest) return Math.atan2(nearest.dx, nearest.dy) * 180 / Math.PI;
  const heading = Number(vehicle.heading);
  return vehicle.heading != null && Number.isFinite(heading) ? heading : fallback();
}

function vehicleLocationText(vehicle, route, stops = []) {
  const direction = route?.directions?.find((item) => item.id === vehicle?.route_direction_id);
  const position = vehicle?.current_position || {};
  const nextIndex = direction?.stops ? positionStopIndex(direction.stops, position) : -1;
  const nextStop = direction?.stops?.[nextIndex] || direction?.stops?.find((stop) => stop.sequence === vehicle?.route_sequence);
  const stopName = (stop) => displayStopName({ ...stops.find((item) => item.id === stop?.id), ...stop }) || stop?.id || '';
  if (!nextStop) return '';
  const nextName = stopName(nextStop);
  if (position.type === 'between_stops') {
    const previousName = stopName(direction.stops[nextIndex - 1]);
    const distance = Number(position.distance_to_next_stop);
    return [previousName && `${previousName} - ${nextName}`, Number.isFinite(distance) && `${Math.round(distance)}m`]
      .filter(Boolean).join(' ');
  }
  return `${nextName} 进站`;
}

function formatUpdated(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '—';
}

/* ======================= 数据接口（与官方站点同源） ======================= */
async function publicApi(path) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}${separator}_=${Date.now()}`;
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).error || message; } catch { /* 非 JSON 响应 */ }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json();
}

const busApi = {
  routes: () => publicApi('/routes'),
  stops: () => publicApi('/stops'),
  vehicles: (all = false) => publicApi(all ? '/vehicles/all' : '/vehicles'),
};

/* ======================= 地图数据组装（与参考站 BusMapV2 一致） ======================= */
const activeVehicles = () => state.vehicles.filter(
  (vehicle) => Number.isFinite(+vehicle.longitude) && Number.isFinite(+vehicle.latitude));
const routeFor = (id) => state.routes.find((route) => route.id === id);
// 该视图为 neutral 模式：线路灰色、站点浅灰（与官方"所有车辆实时位置"一致）
const NEUTRAL_ROUTE_COLOR = '#aaa';
const NEUTRAL_STOP_COLOR = '#ccc';
const sourceData = (features) => ({ type: 'FeatureCollection', features });

function vehicleBearing(vehicle) {
  const direction = routeFor(vehicle.route_id)?.directions?.find((item) => item.id === vehicle.route_direction_id);
  return vehicleBearingAt(parseGeometry(direction?.geometry_json), direction?.stops, vehicle);
}

function routeFeatures() {
  return state.routes.flatMap((route) => (route.directions || []).map((direction) => ({
    type: 'Feature',
    properties: { color: NEUTRAL_ROUTE_COLOR },
    geometry: { type: 'LineString', coordinates: parseGeometry(direction.geometry_json) },
  })).filter((feature) => feature.geometry.coordinates.length > 1));
}

function stopFeatures() {
  const stops = new Map();
  state.routes.forEach((route) => (route.directions || []).forEach((direction) => (direction.stops || []).forEach((stop) => {
    const longitude = +stop.longitude;
    const latitude = +stop.latitude;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    const key = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
    const name = displayStopName({ ...state.stops.find((item) => item.id === stop.id), ...stop }) || stop.id;
    const existing = stops.get(key);
    if (existing) {
      if (name && !existing.properties.names.includes(name)) existing.properties.names.push(name);
      return;
    }
    stops.set(key, {
      type: 'Feature',
      properties: { names: name ? [name] : [], color: NEUTRAL_STOP_COLOR },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    });
  })));
  return [...stops.values()].map((feature) => ({ ...feature, properties: { ...feature.properties, name: feature.properties.names.join(' / ') } }));
}

/* ======================= 地图渲染 ======================= */
function fitToStops() {
  const coordinates = stopFeatures().map((feature) => feature.geometry.coordinates);
  if (!coordinates.length) return;
  const bounds = coordinates.reduce(
    (current, coordinate) => current.extend(coordinate),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
  map.fitBounds(bounds, { padding: 48, maxZoom: 14.5, duration: 0 });
}

function addLayers() {
  if (!map || !map.isStyleLoaded()) return;
  if (!map.getSource('bus-v2-routes')) map.addSource('bus-v2-routes', { type: 'geojson', data: sourceData(routeFeatures()) });
  if (!map.getLayer('bus-v2-routes')) map.addLayer({
    id: 'bus-v2-routes', type: 'line', source: 'bus-v2-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.8 },
  });
  if (!map.getSource('bus-v2-stops')) map.addSource('bus-v2-stops', { type: 'geojson', data: sourceData(stopFeatures()) });
  if (!map.getLayer('bus-v2-stops')) map.addLayer({
    id: 'bus-v2-stops', type: 'circle', source: 'bus-v2-stops',
    paint: { 'circle-radius': 4, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#202127' },
  });
  if (!map.getLayer('bus-v2-stop-labels')) map.addLayer({
    id: 'bus-v2-stop-labels', type: 'symbol', source: 'bus-v2-stops', minzoom: 16.5,
    layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1], 'text-anchor': 'top' },
    paint: { 'text-color': '#ebebf5', 'text-halo-color': '#202127', 'text-halo-width': 2 },
  });
  if (!mapEventsBound) {
    map.on('click', 'bus-v2-stops', showStopPopup);
    map.on('click', () => {
      if (!map.queryRenderedFeatures(undefined, { layers: ['bus-v2-stops'] }).length) closeVehiclePopup();
    });
    map.on('mouseenter', 'bus-v2-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'bus-v2-stops', () => { map.getCanvas().style.cursor = ''; });
    mapEventsBound = true;
  }
}

function refresh() {
  if (!mapLoaded || !map) return;
  map.getSource('bus-v2-routes')?.setData(sourceData(routeFeatures()));
  map.getSource('bus-v2-stops')?.setData(sourceData(stopFeatures()));
  refreshVehicleMarkers();
}

/* ======================= 车辆标记 ======================= */
function clearVehicleMarkers() {
  vehicleMarkers.forEach((record) => { cancelAnimationFrame(record.frame); record.marker.remove(); });
  vehicleMarkers = new Map();
}

function settleVehicleMarkers() {
  vehicleMarkers.forEach((record) => {
    cancelAnimationFrame(record.frame);
    record.element.style.transition = 'none';
    record.element.style.transform = '';
  });
}

function updateVehicleMarker(record, vehicle) {
  record.vehicle = vehicle;
  const route = routeFor(vehicle.route_id);
  record.element.className = `vehicle status-${vehicle.data_status || 'offline'}`;
  const title = displayName(vehicle) || vehicle.id;
  record.element.title = title;
  record.element.setAttribute('aria-label', title);
  record.element.style.setProperty('--route-color', route?.color || '#2878c8');
  const bearing = vehicleBearing(vehicle);
  record.element.style.setProperty('--bearing', `${bearing}deg`);
  const rightBearing = (bearing + 90) * Math.PI / 180;
  record.marker?.setOffset(state.avoidOverlap ? [Math.sin(rightBearing) * 10, -Math.cos(rightBearing) * 10] : [0, 0]);
}

function moveVehicleMarker(record, longitude, latitude) {
  cancelAnimationFrame(record.frame);
  const start = record.marker.getLngLat();
  const target = [+longitude, +latitude];
  if (start.lng === target[0] && start.lat === target[1]) return;
  const startPoint = map.project(start), targetPoint = map.project(target);
  record.marker.setLngLat(target);
  record.element.style.transition = 'none';
  record.element.style.transform = `translate(${startPoint.x - targetPoint.x}px, ${startPoint.y - targetPoint.y}px)`;
  record.frame = requestAnimationFrame(() => {
    record.element.style.transition = 'transform 1s linear';
    record.element.style.transform = '';
  });
}

function createVehicleMarker(vehicle) {
  const record = { vehicle, marker: null, frame: 0, element: null };
  // 容器 40×60 完整包含方向箭头，防止缩放时坐标错位；锚点 center 对准 GPS 坐标
  const markerElement = document.createElement('div');
  markerElement.className = 'vehicle-marker';
  const element = document.createElement('button');
  const arrow = document.createElement('span');
  const image = document.createElement('img');
  arrow.className = 'vehicle-arrow';
  image.src = String(vehicle.vehicle_type).toUpperCase() === 'SHUTTLE' ? 'img/sev.png' : 'img/bus.png';
  image.alt = '';
  element.type = 'button';
  element.append(arrow, image);
  markerElement.append(element);
  element.addEventListener('click', (event) => { event.stopPropagation(); showVehiclePopup(record.vehicle); });
  record.element = element;
  updateVehicleMarker(record, vehicle);
  record.marker = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
    .setLngLat([+vehicle.longitude, +vehicle.latitude]).addTo(map);
  updateVehicleMarker(record, vehicle);
  return record;
}

function refreshVehicleMarkers() {
  if (!map || !maplibregl) return;
  const visibleVehicles = activeVehicles(), visibleIds = new Set(visibleVehicles.map((vehicle) => vehicle.id));
  vehicleMarkers.forEach((record, id) => {
    if (!visibleIds.has(id)) { cancelAnimationFrame(record.frame); record.marker.remove(); vehicleMarkers.delete(id); }
  });
  visibleVehicles.forEach((vehicle) => {
    const record = vehicleMarkers.get(vehicle.id);
    if (!record) vehicleMarkers.set(vehicle.id, createVehicleMarker(vehicle));
    else { updateVehicleMarker(record, vehicle); moveVehicleMarker(record, vehicle.longitude, vehicle.latitude); }
  });
  // 路线数据变化后主动刷新方向箭头，避免箭头缺失
  vehicleMarkers.forEach((record) => updateVehicleMarker(record, record.vehicle));
  const selected = state.selectedVehicle && visibleVehicles.find((vehicle) => vehicle.id === state.selectedVehicle.id);
  if (!selected && state.selectedVehicle) closeVehiclePopup();
  if (selected) showVehiclePopup(selected);
}

/* ======================= 弹窗 ======================= */
function closeVehiclePopup() {
  vehicleDetailMarker?.remove();
  vehicleDetailMarker = null;
  state.selectedVehicle = null;
}

function showVehiclePopup(vehicle) {
  activePopup?.remove();
  activePopup = null;
  closeVehiclePopup();
  state.selectedVehicle = vehicle;
  const route = routeFor(vehicle.route_id);
  const direction = route?.directions?.find((item) => item.id === vehicle.route_direction_id);

  const content = document.createElement('article');
  content.className = 'vehicle-detail';
  content.style.setProperty('--route-color', route?.color || vehicle.route_color || '#2878c8');
  content.addEventListener('click', (event) => event.stopPropagation());

  const head = document.createElement('div');
  head.className = 'vehicle-detail__head';
  const strong = document.createElement('strong');
  strong.textContent = displayName(vehicle) || vehicle.id || '';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (event) => { event.stopPropagation(); closeVehiclePopup(); });
  head.append(strong, closeBtn);
  content.append(head);

  const line = document.createElement('p');
  const dot = document.createElement('i');
  const directionName = displayName(direction);
  line.append(dot, document.createTextNode(
    `${displayName(route) || vehicle.route_id || ''}${directionName ? ` · ${directionName}` : ''}`));
  content.append(line);

  const dl = document.createElement('dl');
  const rows = [];
  if (vehicle.service_type) rows.push(['服务类型', vehicle.service_type]);
  rows.push(['车型', vehicle.vehicle_type || '—']);
  const locationText = vehicleLocationText(vehicle, route, state.stops);
  if (locationText) rows.push(['运行位置', locationText]);
  rows.push(['更新时间', formatUpdated(vehicle.source_updated_at || vehicle.received_at)]);
  rows.forEach(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  });
  content.append(dl);

  vehicleDetailMarker = new maplibregl.Marker({ element: content, anchor: 'bottom', offset: [0, -18] })
    .setLngLat([+vehicle.longitude, +vehicle.latitude]).addTo(map);
}

function showStopPopup(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  closeVehiclePopup();
  activePopup?.remove();
  const content = document.createElement('strong');
  content.textContent = feature.properties.name || '站点';
  activePopup = new maplibregl.Popup({ offset: 12 })
    .setLngLat(feature.geometry.coordinates).setDOMContent(content).addTo(map);
}

/* ======================= 地图控件 ======================= */
/* 归属控件默认收起：保留 maplibregl-compact（显示 "i" 按钮），
   移除 maplibregl-compact-show（隐藏展开的归属文案）。
   提前加上 compact 还可阻止 maplibre 在数据到达后自动展开 */
function collapseAttribution() {
  const attrib = el.map && el.map.querySelector('.maplibregl-ctrl-attrib');
  if (!attrib) return;
  attrib.classList.add('maplibregl-compact');
  attrib.classList.remove('maplibregl-compact-show');
  attrib.removeAttribute('open');
}

function createInteractionLockControl() {
  return {
    onAdd(currentMap) {
      const container = document.createElement('div');
      const button = document.createElement('button');
      let enabled = true;
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const update = () => {
        ['dragPan', 'boxZoom', 'doubleClickZoom', 'touchZoomRotate', 'scrollZoom'].forEach(
          (key) => currentMap[key]?.[enabled ? 'enable' : 'disable']());
        button.className = 'maplibregl-ctrl-icon';
        button.textContent = enabled ? '🖐' : '🔒';
        button.setAttribute('aria-label', enabled ? '锁定地图交互' : '解锁地图交互');
        button.title = button.getAttribute('aria-label');
      };
      button.type = 'button';
      button.addEventListener('click', (event) => {
        enabled = !enabled;
        update();
        event.preventDefault();
        event.stopPropagation();
      });
      container.append(button);
      update();
      this.container = container;
      return container;
    },
    onRemove() { this.container?.remove(); this.container = null },
  };
}

function showMapMessage(message) {
  el.mapMessage.textContent = message;
  el.mapMessage.hidden = false;
}

function hideMapMessage() {
  el.mapMessage.hidden = true;
}

/* ======================= 初始化 ======================= */
async function initMap() {
  // 依赖库存在性判断：不可用时降级为纯数据模式，不阻塞应用启动
  if (typeof window.pmtiles === 'undefined') throw new Error('pmtiles 未加载');
  try {
    const module = await import('../vendor/maplibre-gl.mjs');
    maplibregl = module.default || module;
  } catch (error) {
    throw new Error(`地图库加载失败：${error.message || error}`);
  }
  if (!maplibregl || typeof maplibregl.Map !== 'function') throw new Error('地图库不可用');

  const protocol = new window.pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  map = new maplibregl.Map({
    container: el.map,
    style: `${DARK_STYLE}?v=${CACHE_BUST}`,
    center: CAMPUS_CENTER,
    zoom: 14,
    minZoom: 12,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  map.addControl(new maplibregl.FullscreenControl(), 'top-left');
  map.addControl(createInteractionLockControl(), 'top-left');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');

  // 归属信息（Protomaps / OpenStreetMap）默认收起为 "i" 按钮，点击才展开
  collapseAttribution();
  map.on('load', collapseAttribution);

  map.on('style.load', () => { addLayers(); refresh(); });
  map.on('movestart', settleVehicleMarkers);
  map.on('load', () => {
    mapLoaded = true;
    addLayers();
    fitToStops();
    refresh();
    hideMapMessage();
  });
  map.on('error', (event) => {
    if (!mapLoaded && event.error) showMapMessage(`地图不可用：${event.error.message}`);
  });
}

/* ======================= 数据轮询与界面状态 ======================= */
function updateLastUpdated() {
  const times = state.vehicles
    .map((vehicle) => vehicle.source_updated_at || vehicle.received_at)
    .filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (!times.length) { el.lastUpdated.textContent = ''; return; }
  const latest = Math.max(...times);
  const age = Math.max(0, Math.floor((Date.now() - latest) / 1000));
  el.lastUpdated.textContent = age <= 120
    ? `更新于 ${age}s前`
    : `更新于 ${new Date(latest).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}`;
}

function renderState() {
  if (state.loading) {
    el.vehiclesState.hidden = false;
    el.vehiclesState.className = 'state muted';
    el.vehiclesState.textContent = '正在加载…';
  } else if (state.error) {
    el.vehiclesState.hidden = false;
    el.vehiclesState.className = 'state error';
    el.vehiclesState.setAttribute('role', 'alert');
    el.vehiclesState.textContent = '暂时无法获取车辆数据，可点击右下角按钮重试。';
  } else if (!state.vehicles.length) {
    el.vehiclesState.hidden = false;
    el.vehiclesState.className = 'state muted';
    el.vehiclesState.textContent = '当前没有运营中的车辆。';
  } else {
    el.vehiclesState.hidden = true;
  }
}

function updateRefreshRing() {
  if (el.refreshRing) el.refreshRing.style.strokeDashoffset = String(113.1 * (1 - remaining / REFRESH_SECONDS));
}

async function loadVehicles() {
  try {
    const vehicles = await busApi.vehicles(state.showAllVehicles);
    state.vehicles = Array.isArray(vehicles) ? vehicles : [];
    state.loading = false;
    state.error = false;
    refreshVehicleMarkers();
    updateLastUpdated();
  } catch (error) {
    state.loading = false;
    state.error = true;
  } finally {
    renderState();
    remaining = REFRESH_SECONDS;
    updateRefreshRing();
  }
}

async function loadRoutesAndStops() {
  const [routes, stops] = await Promise.all([busApi.routes(), busApi.stops()]);
  state.routes = Array.isArray(routes) ? routes : [];
  state.stops = Array.isArray(stops) ? stops : [];
  // 线路数据就绪后主动刷新车辆方向箭头
  refresh();
  refreshVehicleMarkers();
}

/* ======================= 启动 ======================= */
function hideSplash() {
  el.splash?.classList.add('hidden');
}

async function init() {
  showMapMessage('正在加载地图…');
  el.toggleAllVehicles.addEventListener('change', () => {
    state.showAllVehicles = el.toggleAllVehicles.checked;
    loadVehicles();
  });
  el.toggleAvoidOverlap.addEventListener('change', () => {
    state.avoidOverlap = el.toggleAvoidOverlap.checked;
    refreshVehicleMarkers();
  });
  el.refreshBtn.addEventListener('click', () => loadVehicles());

  renderState();
  updateRefreshRing();

  try {
    await initMap();
  } catch (error) {
    // 地图不可用时自动降级：界面其余部分继续工作
    showMapMessage(`地图不可用：${error.message || error}`);
    console.error(error);
  }

  await loadRoutesAndStops();
  await loadVehicles();

  // 秒级时钟：更新于 Xs前 + 刷新倒计时环
  setInterval(() => {
    updateLastUpdated();
    remaining -= 1;
    if (remaining <= 0) {
      remaining = REFRESH_SECONDS;
      loadVehicles();
    }
    updateRefreshRing();
  }, 1000);
}

async function boot() {
  try {
    await init();
  } catch (error) {
    // 无论是否发生异常，启动页加载动画都必须被隐藏
    console.error(error);
  } finally {
    hideSplash();
  }
}

if (window.cordova) {
  document.addEventListener('deviceready', boot, false);
} else {
  boot();
}
