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

`src-tauri/src/branding.rs` embeds `128x128.png` and `32x32.png` at compile
time. Icons are re-applied on app start, window focus, and tray restore so
Windows does not fall back to the generic placeholder during WebView2 hangs.
