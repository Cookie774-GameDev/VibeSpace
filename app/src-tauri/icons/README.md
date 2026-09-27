# VibeSpace app icons

Official logo sources live in this folder. Generated PNG / ICO / ICNS
bundles **must be committed** — CI release builds and `include_bytes!` in
`src/branding.rs` depend on them.

## Regenerate everything

```bash
cd app
npm run icons:generate
```

This crops `app-icon-source.png` to a square, runs `tauri icon`, and syncs
`public/favicon-*` for the web shell.

## Source files

| File | Purpose |
|------|---------|
| `app-icon-source.png` | Full marketing asset (may be non-square) |
| `app-icon-square.png` | Auto-cropped square used by `tauri icon` |
| `32x32.png` … `icon.ico` | Generated platform bundle (commit all) |

## Runtime branding

`src-tauri/src/branding.rs` embeds icons at compile time:

| Surface | Asset |
|---------|-------|
| Windows taskbar / window | multi-size `icon.ico` embedded in the `.exe` |
| Windows tray | `32x32.png` in `branding.rs` |
| Windows Start menu / pinned shortcut | `icon.ico` embedded in the `.exe` at build |
| Web favicon | synced to `public/favicon.ico` |

The Windows process uses its own `ai.vibespace.desktop` shell identity so an
older Jarvis shortcut cannot supply its orange J icon. The Tauri identifier
remains `ai.jarvis.desktop` to preserve existing app data.

On Windows, `branding_windows.rs` also:

- calls `SetCurrentProcessExplicitAppUserModelID` (`ai.vibespace.desktop`)
- provides a bounded `WM_SETICON` helper for both `ICON_SMALL` and `ICON_BIG`
  from the embedded `icon.ico` resource when a window needs an explicit refresh
