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

## Companion IDE Extension

Install the matching VS Code / Cursor / Trae extension:

- Marketplace: **Pi IDE Bridge (VS Code / Cursor / Trae)**
- Or from the `.vsix` in the GitHub releases.

## License

MIT
