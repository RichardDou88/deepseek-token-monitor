# DeepSeek Token Monitor v2.0

实时监控 DeepSeek API Token 消耗的桌面壁纸。基于 Wallpaper Engine Web 类型。

## 功能

- 📊 本月 / 今日 Token 用量 + 环比对比
- 💰 实时费用计算（人民币）
- 🎯 缓存命中率监控 + 低于 90% 预警
- 🌓 深浅主题一键切换
- 🔄 平台数据自动同步
- 📈 输入 / 输出 / 命中 / 未命中详细拆解
- ✨ 粒子动画背景
- 📱 自适应屏幕缩放

## 快速开始

### 1. 安装依赖
双击 `setup.bat`（需先安装 Node.js）

### 2. 启动后端服务
双击 `start.bat`

### 3. 安装壁纸到 Wallpaper Engine
将 `wallpaper-engine` 文件夹复制到：
```
C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\projects\myprojects\
```

### 4. 启用壁纸
- 打开 Wallpaper Engine
- 在库中找到 "DeepSeek Token Monitor"
- 点击应用

### 5. 配置 API
浏览器打开 http://localhost:3000 填写 DeepSeek API 信息

## 发布到 Workshop
1. 在 WE 库中右键壁纸 → "在资源管理器中打开"
2. 在弹出的编辑器窗口中点击 "发布到 Workshop"
3. 填写描述和标签，确认发布

## 文件结构
```
Token-Monitor-v2.0/
├── wallpaper-engine/      ← 复制到 WE myprojects 文件夹
│   ├── project.json
│   ├── wallpaper.html
│   └── preview.png
├── server/                ← 后端（放在你喜欢的任何位置）
│   ├── server.js
│   ├── package.json / .lock
│   └── ...
├── start.bat              ← 改 server/ 路径后使用
├── setup.bat              ← 安装 Node.js 依赖
└── README.md
```

## 系统要求
- Windows 10/11
- Node.js 18+ → https://nodejs.org/zh-cn/download/
- Wallpaper Engine (Steam)
