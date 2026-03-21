# OpenClaw Desktop

一个基于 `React + Electron` 的桌面端 OpenClaw 启动器。

现在项目已经接入了两种“热更新 / 更新”能力：

- 开发模式：`Vite` 自带前端热刷新
- 打包应用：`electron-updater` 自动检查、下载、重启安装新版本

现在的流程不是先打开 ChatGPT，而是：

1. 打开桌面应用。
2. 首屏先检查 `Node / pnpm / openclaw / gateway token`。
3. 环境 OK 后，直接在应用内部进入 OpenClaw 对话页。

## 项目结构

```text
src/
  electron/
    main.js
    preload.js
    openclaw-launcher.js
  renderer/
    App.jsx
    main.jsx
    styles.css
```

## 启动

先安装依赖：

```bash
npm install
```

如果你是用 `pnpm install`，而且后面启动时报下面这类错误：

```bash
Electron failed to install correctly
```

说明 `electron` 的安装脚本没跑，执行这条修复：

```bash
npm run fix:electron
```

这个修复脚本会默认走国内镜像：

```bash
https://npmmirror.com/mirrors/electron/
```

如果你想手动指定，也可以这样执行：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run fix:electron
```

如果你坚持全程用 `pnpm`，也可以这样：

```bash
pnpm install
npm run fix:electron
```

本地开发：

```bash
npm run dev
```

开发模式下前端改动会直接热刷新；Electron 主进程改动仍然需要重启应用。

只启动 Electron：

```bash
npm run start
```

打包：

```bash
npm run pack
npm run dist
```

如果你要把构建产物直接发布到更新服务器：

```bash
npm run dist:update
```

## 使用方式

1. 启动应用。
2. 首屏会自动检查 OpenClaw 环境。
3. 填写 `gateway token`。
4. 点击“检查环境并开始对话”。
5. 如果本地缺依赖，应用会先尝试自动补齐，再进入 OpenClaw 对话页。

## 自动更新配置

自动更新只在**打包后的应用**里生效，开发模式会显示“开发模式不检查自动更新”。

当前实现使用 `generic provider`，你可以二选一配置更新源：

1. 运行时环境变量

```bash
OPENCLAW_DESKTOP_UPDATE_URL=https://your-domain.com/openclaw-desktop
OPENCLAW_DESKTOP_UPDATE_CHANNEL=latest
```

2. 本地配置文件

路径：

```bash
~/Library/Application Support/chatgpt-sync-desktop/app-update.json
```

内容示例：

```json
{
  "provider": "generic",
  "url": "https://your-domain.com/openclaw-desktop",
  "channel": "latest"
}
```

你的更新服务器目录里至少要有：

- `latest-mac.yml`
- `OpenClaw Desktop-<version>-arm64.zip`
- 对应的 `.blockmap`

这几个文件会在执行 `npm run dist` / `npm run dist:update` 后由 `electron-builder` 生成。

注意：

- macOS 自动更新通常要求签名后的应用
- `zip` 目标不能删，`electron-updater` 在 macOS 依赖它做增量/标准更新

## 后续可加

- 系统托盘常驻
- 快捷键呼出窗口
- 多实例 / 多 token 切换
- 更完整的 OpenClaw 安装流程
- 聊天记录本地索引
