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
| Windows taskbar / window / tray (runtime) | `32x32.png` in `branding.rs` |
| Windows Start menu / pinned shortcut | `icon.ico` embedded in the `.exe` at build |
| Web favicon | synced to `public/favicon.ico` |

Runtime branding re-applies on focus, resize, tray restore, and a Windows watchdog
so WebView2 cannot leave the generic placeholder on the taskbar.
