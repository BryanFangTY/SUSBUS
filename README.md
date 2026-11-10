# SUSBUS — 南方科技大学校园巴士实时位置地图

SUSBUS 是一款 Android 应用（APK），在深色模式地图上实时展示南方科技大学校园巴士与电瓶车的当前位置、行驶方向和线路走向，覆盖 1路、2路 及工作日高峰期快线 K1路（顺时针）、K2路（逆时针）。项目为 **仅含车辆实时位置地图** 的精简版，聚焦"打开即看车辆在哪"这一个核心场景。

> 📱 直接安装：前往 [Releases](https://github.com/BryanFangTY/SUSBUS/releases/latest) 下载最新的 `SUSBUS-*-release.apk`

## 功能特性

- **车辆实时位置**：地图上实时渲染巴士 / 电瓶车位置，10 秒自动刷新，也可用右下角刷新按钮（带进度环）手动刷新
- **行驶方向箭头**：按车辆在相邻站点间的线路投影推算行驶方向，环线重复走廊用站点序列单调性消歧，无投影时按距下一站里程估算路段走向
- **线路与站点**：绘制线路与站点图层，统一使用中性灰色（线路 `#aaa`、站点 `#ccc`），点击站点弹出站名
- **车辆详情弹窗**：点击车辆查看车辆名称、服务类型、车型、运行位置、更新时间
- **线路主题色**：1路 `#42B44B`、K1路 `#006C41`、2路 `#E96982`、K2路 `#CB4543`，应用于车辆标记、方向箭头与详情弹窗，未匹配线路回退接口配色
- **避免重叠**：可开启图标避让，防止同位置车辆互相遮挡
- **全部车辆开关**：可选择显示包括暂停服务在内的所有车辆
- **深色模式**：完整还原参考站点的深色配色（地图底色 `#202127` 起）
- **弱网稳健性**：单次请求 8 秒超时，车辆轮询带并发锁与请求序号（丢弃乱序过期响应），弱网挂起时不会叠加请求
- **线路降级重试**：线路 / 站点数据加载失败时在地图上显示提示，并按 3 个刷新周期（30 秒）降频重试，不阻塞车辆轮询
- **稳健启动**：启动加载动画由 `try/finally` 兜底，任何初始化异常都不会卡在启动页；地图库缺失时自动降级，不阻塞应用

## 无障碍支持

- 地图区域、刷新按钮等控件均带 `aria-label`，刷新按钮支持键盘操作
- 加载状态 `role="status"` + `aria-live="polite"`，错误提示 `role="alert"` 实时播报
- 数据更新播报与秒级时间戳解耦：时间戳不再进入 `aria-live`，改由屏幕阅读器专用状态区（`.sr-only`）仅在轮询成功后播报车辆数量，避免读屏器被每秒变化的时间刷屏

## 技术栈

| 组件 | 说明 |
| --- | --- |
| Cordova Android 15.1.0 | 混合应用外壳，包名 `cn.sustech.susbus` |
| MapLibre GL JS 6.8.0 | 地图渲染引擎（本地 `www/vendor/` 引用，**无外部 CDN**） |
| pmtiles 4.5.0 | 矢量底图协议（本地引用） |
| 原生 ES Module JS | 无前端框架依赖，入口 `www/js/app.js` |

所有第三方库均下载到本地引用，避免 Cordova WebView 网络环境导致的加载失败。

## 目录结构

```text
SUSBUS/
├── susbus-app/                # Cordova Android 工程
│   ├── www/                   # 应用前端
│   │   ├── index.html         # 页面骨架（含启动动画与无障碍结构）
│   │   ├── js/app.js          # 地图与车辆渲染核心逻辑
│   │   ├── css/app.css        # 深色模式样式
│   │   ├── img/               # 车型图标（巴士 / 电瓶车）
│   │   └── vendor/            # MapLibre GL JS、pmtiles 本地化副本
│   ├── config.xml             # Cordova 配置（包名、SDK 版本、背景色等）
│   └── package.json           # cordova-android、cordova-plugin-geolocation
├── vendor-pkg/                # 第三方地图库 tgz 离线归档
├── routes_sample.json         # 线路数据样例
└── README.md
```

## 开发与构建

### 环境要求

- Node.js + npm
- Android SDK（compileSdk 36）
- Java 17（cordova-android 15.x 要求）

### 调试运行

```powershell
cd susbus-app
npm install
npx cordova platform add android    # 首次需要
npx cordova run android
```

### 构建 APK

```powershell
cd susbus-app
npm install
npx cordova build android
# 产物：platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

构建注意事项：国内网络环境下 `services.gradle.org` 可能不可达，需预先缓存 Gradle 发行包到 `~/.gradle/wrapper/dists/`；`config.xml` 的 `BackgroundColor` 必须使用 `#RRGGBB` 格式。

## 系统兼容

- Android 7.0+（minSdk 24）
- 适配 Android 16（compileSdk / targetSdk 36）

## 数据来源

车辆与线路数据来自 SUSTech 校园巴士实时接口（`buseta.sustcra.com`），数据源、坐标体系、线路配色与渲染逻辑对齐参考站点 [sustech.online/transport/bustimer.html](https://sustech.online/transport/bustimer.html)。

自 2026-11-09 起学校实施新校巴运行方案：工作日高峰期在 1路、2路 基础上开行快线 K1路（顺时针）/ K2路（逆时针），走行路线与原 1、2路 略有差异（经学生宿舍、工学院南），停站更少、由巴士全程运行；应用随接口数据自动适配新线路。方案详情见[交协公告《校巴快线即将开行！》](https://mp.weixin.qq.com/s/HuS9QpMQMHzKgWnVScFjhw)。

---

本项目由 TRAE + Mimo-V2.6-Pro 辅助生成。
