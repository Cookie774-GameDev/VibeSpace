# VibeSpace app icons

Source asset: `app-icon.jpg` (official VibeSpace orange V squircle logo).
Regenerate the full platform bundle after changing branding:

```bash
cd app
npx tauri icon ./src-tauri/icons/app-icon.jpg
```

On Windows, if `tauri icon` fails with file-lock errors, regenerate PNG/ICO
sizes with Pillow from the same source image.

Generated outputs (commit all of these):

```
src-tauri/icons/
  32x32.png
  64x64.png
  128x128.png
  128x128@2x.png
  icon.png          # 512×512 master
  icon.icns         # macOS
  icon.ico          # Windows taskbar / installer
  Square*Logo.png   # Microsoft Store / MSIX
  StoreLogo.png
  android/ …        # Android launcher mipmaps
```

`tauri.conf.json` lists the PNG/ICNS/ICO set under `bundle.icon`. The tray
uses `32x32.png`; the main window taskbar icon is set at runtime from
`128x128.png` and embedded in release binaries via `icon.ico` / `icon.icns`.

Web favicons live in `app/public/` (`favicon.ico`, `favicon-32.png`,
`vibespace-icon.png`) and are referenced from `app/index.html`.
