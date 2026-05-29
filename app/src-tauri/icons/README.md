# Jarvis app icons

V1 ships with a single placeholder SVG (`icon.svg`) and **no generated PNG /
ICO / ICNS bundle**. The Tauri config (`tauri.conf.json`) intentionally omits
the `bundle.icon` array for V1 so that `npm run tauri:dev` and
`npm run tauri:build` succeed before real branding is finalised. Tauri will
emit a warning at build time but otherwise produce a working binary.

## Regenerating real icons

When real branding is ready, replace `icon.svg` with the final source asset
(1024x1024 SVG or PNG, square, with full bleed) and run:

```bash
cd app
npx tauri icon ./src-tauri/icons/icon.svg
```

This generates the platform set Tauri expects:

```
src-tauri/icons/
  32x32.png
  128x128.png
  128x128@2x.png
  icon.icns         # macOS
  icon.ico          # Windows
  Square*Logo.png   # Microsoft Store / MSIX (multiple sizes)
  StoreLogo.png
```

After generation, add the icon array back to `tauri.conf.json` under `bundle`:

```jsonc
"bundle": {
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

Commit the generated PNG/ICO/ICNS files. CI release builds need them for
codesigned installer bundles.

## Brand notes (placeholder)

- Cyan -> blue -> violet gradient (`#22d3ee` -> `#3b82f6` -> `#8b5cf6`).
- Soft rounded square (radius ~14 / 64).
- White J monogram, stroked, rounded caps.
- 22% white sheen overlay top-to-bottom for depth.

These values match `app/public/jarvis.svg` (the in-app favicon) so the
window taskbar icon and the browser favicon stay consistent until the
brand pass replaces both.
