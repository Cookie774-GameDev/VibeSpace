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
| Windows taskbar / window / Start menu | `icon.ico` (same bytes as the `.exe`) |
| System tray | `icon.ico` on Windows; `32x32.png` elsewhere |
| Web favicon | synced to `public/favicon.ico` |

If Windows search still shows the old purple mark after an update, the OS is
caching the previous `.exe` icon. Reinstall from a fresh build (or unpin and
re-pin the shortcut) after `npm run icons:generate`.

Icons are re-applied on app start, window focus, and tray restore so Windows
does not fall back to a stale placeholder during WebView2 hangs.
