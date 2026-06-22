# Pi IDE Bridge (VS Code / Cursor / Trae)

Companion extension for the [Pi coding agent](https://pi.dev). It sends your editor context to Pi so Pi knows what file you are looking at, what code you have selected, and which files are open.

## Features

- Reports the active file and all workspace roots (multi-root workspace support).
- Reports the current text selection (line range + content).
- Reports open files for enhanced `@` file completion in Pi.
- Sends periodic heartbeats so Pi can show an accurate "connected" / "not connected" status.
- Right-click any file in the Explorer to insert a clickable link into the Pi input editor.
- Right-click selected text in the editor to send it to Pi.
- Right-click selected text in the integrated terminal to send it to Pi.
- Works in VS Code, Cursor, and Trae.

## Install

1. Build the extension:

   ```bash
   npm install --ignore-scripts
   npm run compile
   ```

2. Install into VS Code / Cursor / Trae:

   - Open the `ide-bridge-vscode/` folder in your editor.
   - Press `F5` to launch an Extension Development Host, **or**
   - Run `vsce package` to create a `.vsix`, then install it via the command palette (`Extensions: Install from VSIX`).

3. Install the Pi extension:

   ```bash
   # Global install
   cp ../ide-bridge.ts ~/.pi/agent/extensions/

   # Or project-local:
   # cp ../ide-bridge.ts /path/to/your/project/.pi/extensions/
   ```

   A packaged version is also available on npm as `pi-ide-bridge`:

   ```bash
   pi install npm:pi-ide-bridge
   ```

4. Start Pi in a project that matches the workspace root. The status bar will show `IDE: not connected` until the companion extension activates and sends its first state update.

## Configuration

Open settings (`Cmd/Ctrl + ,`) and search for **Pi IDE Bridge**:

- `piIdeBridge.port` — base port the Pi IDE bridge listens on. Default: `17325`.
- `piIdeBridge.enabled` — turn context reporting on/off. Default: `true`.
- `piIdeBridge.heartbeatInterval` — milliseconds between heartbeat pings. Default: `5000`. Set to `0` to disable.

You can also run **Enable Pi IDE Bridge** / **Disable Pi IDE Bridge** from the command palette.

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| Insert active file into Pi | `Ctrl+Shift+I` | `Cmd+Shift+I` |
| Insert editor selection into Pi | `Ctrl+Shift+S` | `Cmd+Shift+S` |

Shortcuts can be customized in your editor's keyboard settings.

## Inserting files and selections

- **Explorer**: right-click a file and choose **Insert into Pi Agent**. A markdown link like `[filename](file:///path/to/file)` is pasted into the Pi input editor.
- **Editor**: select code, right-click, and choose **Send Selection to Pi Agent**. The selected text is pasted into Pi.
- **Terminal**: select text in the integrated terminal, right-click, and choose **Send Terminal Selection to Pi Agent**.

All insert actions are broadcast to every running Pi instance on the configured port range.

## How it works

The Pi extension starts a small HTTP server on `127.0.0.1`. It first tries the configured base port (default `17325`) and, if that port is already in use by another Pi instance, automatically tries the next ports up to `17325 + 9`. Each new Pi terminal therefore gets its own listener without manual port configuration.

The companion extension POSTs editor state to the entire port range whenever the active editor or selection changes. It also sends periodic heartbeats to `/ide-ping` so Pi can detect when the editor has been closed. Closing a file or clearing the selection sends an empty state, which clears the Pi status bar and stops injecting stale code.

All traffic stays on `127.0.0.1`; no editor content leaves your machine.
