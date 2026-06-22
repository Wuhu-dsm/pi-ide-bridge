# Pi IDE Bridge

Pi extension that bridges your IDE (VS Code, Cursor, Trae) with the Pi coding agent.

## Features

- **Live IDE context**: active file, workspace roots, open files, and current selection.
- **Multi-root workspace support**.
- **Automatic connection state**: shows `VS Code: connected` / `Cursor: connected` / `Trae: connected` and falls back to `not connected` when the IDE closes.
- **Heartbeats** via `/ide-ping` for accurate disconnect detection.
- **File/terminal inserts** from the IDE into Pi's input editor.
- **Enhanced `@` autocompletion** with open IDE files.
- **Slash commands**:
  - `/ide-state`
  - `/ide-bridge-port`
  - `/ide-insert-active-file`
  - `/ide-insert-selection`
  - `/ide-open-files`
  - `/ide-clear-selection`
- **Keyboard shortcuts**:
  - `Ctrl+Shift+A` / `Cmd+Shift+A`: insert active file
  - `Ctrl+Shift+S` / `Cmd+Shift+S`: insert current selection

## Install

```bash
pi install npm:pi-ide-bridge
```

Or install from git:

```bash
pi install git:github.com/Wuhu-dsm/pi-ide-bridge@v0.3.0
```

Then reload Pi:

```text
/reload
```

## Update

```bash
pi update npm:pi-ide-bridge
/reload
```

## Uninstall

```bash
pi remove npm:pi-ide-bridge
/reload
```

## Companion IDE Extension

The companion extension for VS Code / Cursor / Trae is available as a `.vsix` from the GitHub releases:

- Download: https://github.com/Wuhu-dsm/pi-ide-bridge/releases/latest
- Install with your editor's CLI:

```bash
# VS Code
code --install-extension pi-ide-bridge-vscode-0.3.0.vsix

# Cursor
cursor --install-extension pi-ide-bridge-vscode-0.3.0.vsix

# Trae
trae --install-extension pi-ide-bridge-vscode-0.3.0.vsix
```

Or open the Extensions view, click `...` → **Install from VSIX**.

## License

MIT
