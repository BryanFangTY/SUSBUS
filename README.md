# SUSBUS — 南方科技大学校园巴士实时位置地图

SUSBUS 是一款 Android 应用（APK），在深色模式地图上实时展示南方科技大学校园巴士与电瓶车的当前位置、行驶方向和线路走向。项目为 **仅含车辆实时位置地图** 的精简版，聚焦"打开即看车辆在哪"这一个核心场景。

> 📱 直接安装：前往 [Releases](https://github.com/BryanFangTY/SUSBUS/releases/latest) 下载 `SUSBUS.apk`

## 功能特性

- **车辆实时位置**：地图上实时渲染巴士 / 电瓶车位置，10 秒自动刷新，也可用右下角刷新按钮（带进度环）手动刷新
- **行驶方向箭头**：根据接口 `course` 字段旋转车辆图标，无方向数据时按最近路段局部推算
- **线路与站点**：绘制各条运营线路（独立配色）与站点图层，点击站点可查看站点信息
- **车辆详情弹窗**：点击车辆查看车牌、车型、速度、更新时间等实时信息
- **避免重叠**：可开启图标避让，防止同位置车辆互相遮挡
- **全部车辆开关**：可选择显示包括暂停服务在内的所有车辆
- **深色模式**：完整还原参考站点的深色配色（地图底色 `#202127` 起）
- **稳健启动**：启动加载动画由 `try/finally` 兜底，任何初始化异常都不会卡在启动页；地图库缺失时自动降级，不阻塞应用

## 无障碍支持

- 地图区域、刷新按钮等控件均带 `aria-label`，刷新按钮支持键盘操作
- 加载状态 `role="status"` + `aria-live="polite"`，错误提示 `role="alert"` 实时播报
- 更新时间戳使用 `aria-live` 播报数据新鲜度

## 技术栈

| 组件 | 说明 |
| --- | --- |
| Cordova Android 15.1 | 混合应用外壳，包名 `cn.sustech.susbus` |
| MapLibre GL JS 3.6.2 | 地图渲染引擎（本地 `www/vendor/` 引用，**无外部 CDN**） |
| pmtiles 3.2.1 | 矢量底图协议（本地引用） |
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

### 构建发布版 APK

发布签名需要本地自备 `susbus-release.keystore` 与 `build.json`（仓库中不包含这两份文件），然后：

```powershell
npx cordova build android --release --buildConfig build.json
# 产物：platforms/android/app/build/outputs/apk/release/app-release.apk
```

`build.json` 模板（密码请换成自己的，勿提交仓库）：

```json
{
  "android": {
    "release": {
      "keystore": "susbus-release.keystore",
      "storePassword": "<your-store-password>",
      "alias": "<your-key-alias>",
      "password": "<your-key-password>",
      "keystoreType": ""
    }
  }
}
```

构建注意事项：国内网络环境下 `services.gradle.org` 可能不可达，需预先缓存 Gradle 发行包到 `~/.gradle/wrapper/dists/`；`config.xml` 的 `BackgroundColor` 必须使用 `#RRGGBB` 格式。

## 系统兼容

- Android 7.0+（minSdk 24）
- 适配 Android 16（compileSdk / targetSdk 36）

## 数据来源

车辆与线路数据来自 SUSTech 校园巴士实时接口（`buseta.sustcra.com`），数据源、坐标体系、线路配色与渲染逻辑对齐参考站点 [sustech.online/transport/bustimer.html](https://sustech.online/transport/bustimer.html)。

---

本项目由 TRAE + Mimo-V2.6-Pro 辅助生成。
