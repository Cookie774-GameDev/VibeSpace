"""Crop the marketing logo to a square for `npx tauri icon`."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"
SOURCE = ICONS / "app-icon-source.png"
SQUARE = ICONS / "app-icon-square.png"


def main() -> None:
    if not SOURCE.exists():
        fallback = ICONS / "app-icon.jpg"
        if fallback.exists():
            SOURCE.write_bytes(fallback.read_bytes())
        else:
            raise SystemExit(f"Missing icon source: {SOURCE}")

    image = Image.open(SOURCE)
    width, height = image.size
    side = min(width, height)
    cropped = image.crop((0, 0, side, side))
    cropped.save(SQUARE)
    print(f"cropped {width}x{height} -> {side}x{side} -> {SQUARE}")


if __name__ == "__main__":
    main()
