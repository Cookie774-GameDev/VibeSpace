"""Fail CI if Windows icon.ico drifts back to the old purple mark."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"
ICO = ICONS / "icon.ico"
SQUARE = ICONS / "app-icon-square.png"


def dominant_rgb(path: Path) -> tuple[int, int, int]:
    image = Image.open(path).convert("RGB")
    w, h = image.size
    pixels = [
        image.getpixel((w // 2, h // 2)),
        image.getpixel((w // 2, int(h * 0.35))),
        image.getpixel((w // 2, int(h * 0.65))),
    ]
    r = sum(p[0] for p in pixels) // len(pixels)
    g = sum(p[1] for p in pixels) // len(pixels)
    b = sum(p[2] for p in pixels) // len(pixels)
    return r, g, b


def largest_ico_frame(path: Path) -> Image.Image:
    with Image.open(path) as ico:
        best = ico.copy()
        best_size = best.size[0] * best.size[1]
        try:
            while True:
                ico.seek(ico.tell() + 1)
                frame = ico.copy()
                size = frame.size[0] * frame.size[1]
                if size > best_size:
                    best = frame
                    best_size = size
        except EOFError:
            pass
        return best.convert("RGB")


def main() -> None:
    if not ICO.exists():
        raise SystemExit(f"Missing {ICO} — run npm run icons:generate")
    if not SQUARE.exists():
        raise SystemExit(f"Missing {SQUARE} — run npm run icons:generate")

    tmp = ICONS / "_verify_ico_frame.png"
    largest_ico_frame(ICO).save(tmp)

    square_rgb = dominant_rgb(SQUARE)
    ico_rgb = dominant_rgb(tmp)
    tmp.unlink(missing_ok=True)

    # Orange VibeSpace: warm (R dominant). Legacy purple mark: cool (B high, R low).
    if ico_rgb[0] < 120 or ico_rgb[0] < ico_rgb[2]:
        raise SystemExit(
            f"icon.ico looks like the legacy purple mark (rgb={ico_rgb}). "
            "Run npm run icons:generate from app-icon-source.png."
        )

    if abs(ico_rgb[0] - square_rgb[0]) > 80:
        raise SystemExit(
            f"icon.ico rgb={ico_rgb} diverges from source rgb={square_rgb}. "
            "Regenerate icons."
        )

    print(f"icon.ico ok rgb={ico_rgb} (source rgb={square_rgb})")


if __name__ == "__main__":
    main()
