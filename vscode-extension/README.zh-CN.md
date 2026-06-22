# Pi IDE Bridge（VS Code / Cursor / Trae）

这是 [Pi 编程助手](https://pi.dev) 的配套编辑器扩展。它会把当前编辑器的上下文发送给 Pi，让 Pi 知道你在看哪个文件、选中了哪段代码、以及打开了哪些文件。

[English](README.md)

## 主要功能

- 实时上报当前激活文件和所有工作区根目录（支持多根工作区）。
- 上报当前文本选区（行范围 + 内容）。
- 上报已打开文件，增强 Pi 中 `@` 文件补全。
- 定时发送心跳，让 Pi 准确显示“已连接 / 未连接”状态。
- 在资源管理器中右键任意文件，可把可点击的文件链接插入 Pi 输入框。
- 在编辑器中右键选中的文本，可将其发送到 Pi。
- 在集成终端中右键选中的文本，可将其发送到 Pi。
- 支持 VS Code、Cursor 和 Trae。

## 快速安装（推荐）

如果你已经在 Pi 里安装了 Pi IDE Bridge 扩展，直接运行：

```text
/ide init
```

Pi 会自动检测 PATH 上的 VS Code / Cursor / Trae，从 GitHub 下载最新的配套 `.vsix` 并完成安装。支持 macOS、Windows 和 Linux。

如果命令找不到你的编辑器，请确保编辑器的命令行工具已加入 PATH（例如在 VS Code 中运行“Shell Command: Install 'code' command in PATH”）。

## 手动安装

> VS Code Marketplace 版本尚未发布。也可以从 [GitHub releases](https://github.com/Wuhu-dsm/pi-ide-bridge/releases/latest) 下载 `.vsix` 手动安装。

1. 下载最新的 `.vsix`：

   ```bash
   curl -L -o pi-ide-bridge-vscode-0.4.0.vsix \
     https://github.com/Wuhu-dsm/pi-ide-bridge/releases/download/v0.4.0/pi-ide-bridge-vscode-0.4.0.vsix
   ```

2. 安装到编辑器：

   ```bash
   # VS Code
   code --install-extension pi-ide-bridge-vscode-0.4.0.vsix

   # Cursor
   cursor --install-extension pi-ide-bridge-vscode-0.4.0.vsix

   # Trae
   trae --install-extension pi-ide-bridge-vscode-0.4.0.vsix
   ```

   或者在扩展视图中点击 `...` → **Install from VSIX**。

3. 安装 Pi 端的 npm 扩展：

   ```bash
   pi install npm:pi-ide-bridge
   /reload
   ```

4. 在工作区根目录启动 Pi。状态栏会先显示 `IDE: not connected`，等配套扩展激活并发送第一次状态更新后就会变成已连接。

## 配置

打开设置（`Cmd/Ctrl + ,`）并搜索 **Pi IDE Bridge**：

- `piIdeBridge.port` —— Pi IDE bridge HTTP 服务器监听的基础端口。默认：`17325`。
- `piIdeBridge.enabled` —— 是否开启上下文上报。默认：`true`。
- `piIdeBridge.heartbeatInterval` —— 心跳间隔毫秒数。默认：`2000`，设为 `0` 可关闭。

也可以在命令面板中运行 **Enable Pi IDE Bridge** / **Disable Pi IDE Bridge**。

## 快捷键

| 操作 | Windows / Linux | macOS |
|---|---|---|
| 把当前文件插入 Pi | `Ctrl+Shift+I` | `Cmd+Shift+I` |
| 把编辑器选区插入 Pi | `Ctrl+Shift+S` | `Cmd+Shift+S` |

快捷键可以在编辑器的快捷键设置中自定义。

## 插入文件和选区

- **资源管理器**：右键文件并选择 **Insert into Pi Agent**，会把类似 `[filename](file:///path/to/file)` 的 Markdown 链接粘贴到 Pi 输入框。
- **编辑器**：选中代码后右键，选择 **Send Selection to Pi Agent**，选中的文本会被粘贴到 Pi。
- **终端**：在集成终端中选中文字，右键选择 **Send Terminal Selection to Pi Agent**。

所有插入操作都会广播到配置端口范围内运行的每一个 Pi 实例。

## 工作原理

Pi 扩展会在 `127.0.0.1` 上启动一个小的 HTTP 服务器。它首先尝试配置的基础端口（默认 `17325`），如果该端口已被另一个 Pi 实例占用，则自动尝试 `17325 + 9` 范围内的下一个端口。因此每个新的 Pi 终端都能拥有独立的监听器，无需手动配置端口。

配套扩展会在当前激活编辑器或选区变化时，向整个端口范围 POST 编辑器状态；也会定期向 `/ide-ping` 发送心跳，方便 Pi 检测编辑器是否已关闭。关闭文件或清空选区会发送空状态，从而清空 Pi 状态栏并避免注入过期代码。

所有通信都只在 `127.0.0.1` 上进行，不会离开你的机器。
