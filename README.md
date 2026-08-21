# Hid-Drive-Offline-Saver
# 网页Hid离线保存器

[下载](https://github.com/SadYuyuko/Hid-Drive-Offline-Saver/releases/download/v1.0.0/Hid-Drive-Offline-Saver-win32-x64.zip) 解压后运行

把基于 WebHID（鼠标/键盘/手柄等设备）的网页驱动整站离线保存到本地，之后无需联网即可在软件内离线使用，WebHID 设备控制照常工作。

## 功能

- **一键采集**：用真实浏览器内核打开目标网页，自动捕获页面加载的全部资源（含懒加载 chunk），存为离线存档
- **离线使用**：存档通过本地 `127.0.0.1` 服务器运行，`localhost` 属于安全上下文，WebHID 可用
- **HID 权限**：自动放行 HID 权限、可多设备选择，并关闭 HID 黑名单
- **只在本软件内离线可用**：普通浏览器打开 `file://` 无法调用 HID

## 环境要求

- Windows
- [Node.js](https://nodejs.org/) 18+（含 npm）
- WebHID 设备需已插好（仅在 Chromium 内核 / 本软件中可用）

## 安装与启动

```bash
# 安装依赖
npm install

# 启动软件
npm start
```

也可以双击项目根目录的 `启动.bat` 直接启动（无控制台窗口）。

## 使用方法

1. 输入网址，点击「采集」
2. 在弹出的采集窗口里随便操作（连接设备、点进所需功能页等），使其加载所需资源
3. 点击左上角「采集」键，或按 `Ctrl+Shift+S` 保存为离线存档
4. 回到主界面，点击「打开离线版」即可离线使用，WebHID 设备控制照常

> 采集窗口和离线窗口都带菜单栏：`采集 | 刷新 | 放大 | 缩小`。采集窗口的「采集」= 完成保存；离线窗口的「采集」= 呼出主窗口。

## 存档位置

存档保存在系统用户数据目录：

```
%APPDATA%\hid-offline-saver\archives
```

主界面「打开存档文件夹」按钮可直接跳转。

## 工作原理

| 阶段 | 说明 |
| --- | --- |
| 整体架构 | 基于 [Electron](https://www.electronjs.org/) 的桌面应用：主进程负责采集、存档与本地服务器，渲染进程提供图形界面 |
| 采集 | 主进程通过 Chrome DevTools Protocol（CDP）`Network` 域记录页面实际发出的每个请求，用 `Network.getResponseBody` 抓取响应体，按 URL 存为 `manifest.json` + 资源文件 |
| 离线 | 主进程用 Node `http` 服务器把存档挂在 `http://127.0.0.1:<port>/`，页面内对原站的绝对路径引用通过 `webRequest` 重定向到本地副本 |
| HID | 借助 Electron 的 WebHID 支持：`setPermissionCheckHandler` + `setDevicePermissionHandler` 放行 `hid` 权限；`select-hid-device` 事件提供设备选择；`disable-hid-blocklist` 开关关闭 Chromium HID 黑名单 |

### 已知兼容性说明

- 部分站点会拒绝 HTTP/2 或经系统代理访问，软件已默认禁用 HTTP/2 并绕过系统代理（`disable-http2`、`no-proxy-server`）
- 若目标站需要登录态，请在采集窗口内先完成登录再保存

## 开发

```bash
# 语法检查
node --check main.js

# 端到端自测（采集→保存→离线打开→验证 HID）
# 设置环境变量 E2E=1 后启动
```

## 许可证

[MIT](./LICENSE)
