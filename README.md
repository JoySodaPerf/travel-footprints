# travel-footprints · 泰山打卡

记录旅游足迹的 **PWA**：地图定位、景点打卡、背景信息介绍。内置泰山经典红门登山路线 11 个打卡点，手机访问后可直接安装到桌面，离线也能打开。

## 功能

- **地图**：Leaflet + OpenStreetMap，无需任何地图 API Key
- **实时定位**：GPS 高精度追踪，显示精度、海拔、距下一站距离
- **景点打卡**：进入打卡半径（150~220 米）即可打卡，记录时间与坐标
- **背景介绍**：每个景点附历史背景、实用提示（海拔、典故、补给点）
- **进度追踪**：已打卡 X/11，进度条 + 按距离排序的打卡点列表
- **PWA 离线**：Service Worker 缓存应用壳与有限地图瓦片，弱网可用
- **模拟定位**：在地图上点按放置测试位置，方便出发前验证

## 技术栈

纯静态页面：HTML + CSS + 原生 JavaScript + Leaflet（jsdelivr CDN），无构建步骤，天然适配 Cloudflare Pages。

## 目录结构

```
public/                  # 站点根目录（Cloudflare Pages 构建输出目录）
  index.html             # 应用入口
  css/style.css          # 样式
  js/pois.js             # 泰山景点数据（坐标/介绍/打卡半径）
  js/app.js              # 地图、定位、打卡、渲染逻辑
  manifest.webmanifest   # PWA 清单
  sw.js                  # Service Worker（离线缓存）
  icons/                 # 应用图标
wrangler.toml            # Cloudflare Pages 配置
```

## 本地预览

```bash
cd public && python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 部署到 Cloudflare Pages

### 方式一：命令行

```bash
npm i -g wrangler
wrangler pages deploy public --project-name travel-footprints
```

### 方式二：Git 集成

1. 在 Cloudflare Dashboard 创建 Pages 项目，连接本仓库
2. 构建命令留空，输出目录填 `public`
3. 保存后自动部署，得到 `https://travel-footprints.pages.dev`

> 说明：PWA（Service Worker、安装）要求 HTTPS，Cloudflare Pages 默认提供。

## 版本发布

- 修改功能后，将 `public/sw.js` 顶部的 `VERSION` 递增（如 `tf-v2` → `tf-v3`）
- 已安装用户每次启动会检测 `sw.js` 是否变化，变化即自动下载并切换到新版本（下次启动生效）；离线启动则继续使用本地缓存版本

## 修改打卡点

编辑 `public/js/pois.js`，按字段（`name`、`lat`、`lng`、`alt`、`radius`、`intro`、`tip`）增删即可。坐标使用 WGS84，与手机 GPS 和 OpenStreetMap 一致。

## 数据说明

- 打卡记录保存在浏览器 `localStorage`（键 `tf:checkins:v1`），不上传服务器，隐私安全
- 地图瓦片在线加载，离线时仅缓存已浏览过的瓦片（上限 400 张）
- 景点坐标来自公开资料，与实际位置可能存在小幅偏差，打卡半径已做宽容处理
