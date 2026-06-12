#!/usr/bin/env python3
"""VibeSpace install splash — colorful animated terminal branding for GitHub download/install only."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

from boot_common import (
    BOLD,
    CLEAR,
    DIM,
    ERASE_TO_END,
    HIDE_CURSOR,
    HOME,
    RESET,
    SHOW_CURSOR,
    center,
    configure_output,
    enable_ansi_windows,
    orbit_dots,
    pad_visible,
    rgb,
    shimmer_bar,
    strip_ansi_len,
    term_size,
)

# ── Logo art ──────────────────────────────────────────────────────────────────

LOGO_WIDE = [
    "██╗   ██╗██╗██████╗ ███████╗███████╗██████╗  █████╗  ██████╗███████╗",
    "██║   ██║██║██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝",
    "██║   ██║██║██████╔╝█████╗  █████╗  ██████╔╝███████║██║     █████╗  ",
    "╚██╗ ██╔╝██║██╔══██╗██╔══╝  ██╔══╝  ██╔═══╝ ██╔══██║██║     ██╔══╝  ",
    " ╚████╔╝ ██║██████╔╝███████╗███████╗██║     ██║  ██║╚██████╗███████╗",
    "  ╚═══╝  ╚═╝╚═════╝ ╚══════╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝",
]

LOGO_COMPACT = [
    "╦  ╦╦╔╗ ╔═╗╔╗ ┌─┐┌─┐╔═╗╦  ╔═╗╔═╗",
    "╚╗╔╝║╠╩╗╚═╗╠╩╗│ ││ │╠═╝║  ║╣ ╚═╗",
    " ╚╝ ╩╚═╝╚═╝╚═╝└─┘└─┘╩  ╩═╝╚═╝╚═╝",
]

LOGO_MINI = [
    "╦ ╦╦╔╗ ╔═╗╔╗ ┌─┐┌─┐╔═╗╦  ╔═╗",
    "╚╦╝║╠╩╗╚═╗╠╩╗│ ││ │╠═╝║  ║╣ ",
    " ╩ ╩╚═╝╚═╝╚═╝└─┘└─┘╩  ╩═╝╚═╝",
]

INSTALL_STEPS = [
    ("fetch", "Fetching release from GitHub"),
    ("verify", "Verifying installer package"),
    ("install", "Installing VibeSpace"),
    ("launcher", "Wiring terminal launcher"),
    ("ready", "Preparing your workspace"),
]

# ── Theme definitions ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Theme:
    name: str
    title: str
    tagline: str
    hot: Tuple[int, int, int]
    mid: Tuple[int, int, int]
    dim: Tuple[int, int, int]
    peak: Tuple[int, int, int]
    accent: Tuple[int, int, int]
    glow: Tuple[int, int, int]
    logo_fn: Callable[[int, Theme], List[str]]
    frame_fn: Callable[[int, int, Theme], str]


def _logo_nebula(frame: int, t: Theme) -> List[str]:
    lines: List[str] = []
    for i, raw in enumerate(LOGO_WIDE):
        hue_shift = (frame * 3 + i * 18) % 360
        r = int(t.hot[0] + (t.accent[0] - t.hot[0]) * ((hue_shift % 120) / 120))
        g = int(t.hot[1] + (t.accent[1] - t.hot[1]) * ((hue_shift % 90) / 90))
        b = int(t.mid[2] + (t.peak[2] - t.mid[2]) * ((hue_shift % 60) / 60))
        pulse = 1.0 if (frame + i) % 8 < 4 else 0.75
        color = (min(255, int(r * pulse)), min(255, int(g * pulse)), min(255, int(b * pulse)))
        lines.append(rgb(color, raw, bold=(frame + i) % 6 == 0))
    return lines


def _frame_nebula(frame: int, width: int, t: Theme) -> str:
    stars = orbit_dots(frame, min(24, max(12, width // 5)), t.peak, t.accent, t.dim)
    bar = shimmer_bar(frame, min(width - 4, 48), t.hot, t.mid, t.dim, t.peak)
    return f"{stars}\n{bar}"


def _logo_aurora(frame: int, t: Theme) -> List[str]:
    lines: List[str] = []
    wave = [0.0, 0.35, 0.7, 0.35, 0.0, 0.2]
    for i, raw in enumerate(LOGO_WIDE):
        w = wave[(frame // 2 + i) % len(wave)]
        r = int(t.hot[0] * (0.55 + w) + t.accent[0] * (0.45 - w * 0.3))
        g = int(t.mid[1] * (0.5 + w) + t.glow[1] * (0.5 - w * 0.2))
        b = int(t.dim[2] * (0.4 + w) + t.peak[2] * (0.6 - w * 0.3))
        lines.append(rgb((r, g, b), raw, bold=w > 0.5))
    return lines


def _frame_aurora(frame: int, width: int, t: Theme) -> str:
    cols = min(width - 4, 52)
    bands: list[str] = []
    for row in range(3):
        chars: list[str] = []
        for c in range(cols):
            phase = (frame * 2 + c * 4 + row * 11) % 360
            intensity = (phase % 180) / 180.0
            r = int(t.hot[0] * intensity + t.glow[0] * (1 - intensity))
            g = int(t.mid[1] * intensity + t.accent[1] * (1 - intensity))
            b = int(t.dim[2] * 0.3 + t.peak[2] * intensity)
            ch = "▓" if row == 1 else "░"
            chars.append(rgb((r, g, b), ch))
        bands.append("".join(chars))
    return "\n".join(bands)


def _logo_prism(frame: int, t: Theme) -> List[str]:
    palette = [
        (255, 80, 120),
        (255, 160, 60),
        (255, 230, 80),
        (80, 220, 140),
        (70, 180, 255),
        (160, 100, 255),
    ]
    lines: List[str] = []
    for i, raw in enumerate(LOGO_WIDE):
        color = palette[(frame // 3 + i) % len(palette)]
        lines.append(rgb(color, raw, bold=(frame + i) % 4 == 0))
    return lines


def _frame_prism(frame: int, width: int, t: Theme) -> str:
    cols = min(width - 4, 56)
    palette = [
        (255, 90, 130),
        (255, 170, 70),
        (255, 240, 90),
        (90, 230, 150),
        (80, 190, 255),
        (170, 110, 255),
    ]
    scan = frame % cols
    row: list[str] = []
    for c in range(cols):
        color = palette[(c * 2 + frame) % len(palette)]
        if abs(c - scan) <= 1:
            row.append(rgb(t.peak, "█", bold=True))
        elif abs(c - scan) <= 3:
            row.append(rgb(color, "█", bold=True))
        else:
            row.append(rgb(color, "▒"))
    return "".join(row)


THEMES: dict[str, Theme] = {
    "nebula": Theme(
        name="nebula",
        title="Nebula",
        tagline="Cosmic workspace · infinite vibe",
        hot=(120, 70, 255),
        mid=(70, 140, 255),
        dim=(35, 45, 90),
        peak=(200, 160, 255),
        accent=(90, 220, 255),
        glow=(160, 120, 255),
        logo_fn=_logo_nebula,
        frame_fn=_frame_nebula,
    ),
    "aurora": Theme(
        name="aurora",
        title="Aurora",
        tagline="Warm light · creative flow",
        hot=(255, 120, 50),
        mid=(255, 180, 80),
        dim=(90, 55, 35),
        peak=(255, 220, 140),
        accent=(255, 95, 60),
        glow=(255, 200, 120),
        logo_fn=_logo_aurora,
        frame_fn=_frame_aurora,
    ),
    "prism": Theme(
        name="prism",
        title="Prism",
        tagline="Full spectrum · pure energy",
        hot=(255, 100, 150),
        mid=(120, 200, 255),
        dim=(50, 50, 70),
        peak=(255, 255, 255),
        accent=(180, 120, 255),
        glow=(255, 200, 100),
        logo_fn=_logo_prism,
        frame_fn=_frame_prism,
    ),
}

DEFAULT_VARIANT = os.environ.get("VIBESPACE_INSTALL_SPLASH", "aurora").strip().lower() or "aurora"


def pick_logo(width: int) -> List[str]:
    if width >= 72:
        return LOGO_WIDE
    if width >= 40:
        return LOGO_COMPACT
    return LOGO_MINI


def colorize_static_logo(lines: Sequence[str], t: Theme, frame: int) -> List[str]:
    if lines is LOGO_WIDE:
        return t.logo_fn(frame, t)
    out: List[str] = []
    for i, raw in enumerate(lines):
        blend = (frame + i * 7) % 3
        color = t.hot if blend == 0 else t.mid if blend == 1 else t.accent
        out.append(rgb(color, raw, bold=blend == 0))
    return out


def render_progress(step_idx: int, step_progress: float, frame: int, t: Theme, width: int) -> List[str]:
    lines: List[str] = []
    bar_w = min(44, width - 8)
    pulse = "●" if frame % 4 < 2 else "◉"
    for i, (_key, label) in enumerate(INSTALL_STEPS):
        if i < step_idx:
            mark = rgb(t.peak, "✓", bold=True)
            name = rgb(t.mid, label, dim=True)
        elif i == step_idx:
            mark = rgb(t.hot, pulse, bold=True)
            name = rgb(t.hot, label, bold=True)
        else:
            mark = rgb(t.dim, "○", dim=True)
            name = rgb(t.dim, label, dim=True)
        lines.append(f"  {mark} {name}")
        if i == step_idx:
            filled = max(1, int(bar_w * step_progress))
            if filled >= bar_w:
                bar = shimmer_bar(frame, bar_w, t.hot, t.mid, t.dim, t.peak)
            else:
                hot_part = rgb(t.hot, "█" * filled, bold=True)
                dim_part = rgb(t.dim, "░" * (bar_w - filled), dim=True)
                bar = f"{hot_part}{dim_part}"
            lines.append(f"    {bar}")
    return lines


def render_screen(
    frame: int,
    t: Theme,
    step_idx: int,
    step_progress: float,
    status: str,
    subtitle: str,
    done: bool,
) -> str:
    cols, rows = term_size()
    width = max(40, cols)
    logo_lines = pick_logo(width)
    if logo_lines is LOGO_WIDE:
        colored_logo = t.logo_fn(frame, t)
    else:
        colored_logo = colorize_static_logo(logo_lines, t, frame)

    deco = t.frame_fn(frame, width, t)
    deco_lines = deco.split("\n")

    body: List[str] = [CLEAR]
    body.append(center(rgb(t.glow, "◆ VibeSpace Install ◆", bold=True), width))
    body.append("")

    for line in colored_logo:
        body.append(center(line, width))
    body.append("")
    body.append(center(rgb(t.accent, t.tagline, dim=True), width))
    body.append("")

    for dl in deco_lines[:2]:
        body.append(center(dl, width))
    body.append("")

    if done:
        body.append(center(rgb(t.peak, "✦ Installation complete ✦", bold=True), width))
        body.append(center(rgb(t.mid, "Launching VibeSpace…", dim=True), width))
    else:
        for pl in render_progress(step_idx, step_progress, frame, t, width):
            body.append(center(pl, width))
        body.append("")
        body.append(center(rgb(t.hot, status, bold=True), width))
        if subtitle:
            body.append(center(rgb(t.dim, subtitle, dim=True), width))

    body.append("")
    variant_label = rgb(t.dim, f"variant · {t.title.lower()}", dim=True)
    body.append(center(variant_label, width))

    # Trim to terminal height
    max_lines = max(8, rows - 1)
    if len(body) > max_lines:
        body = body[:max_lines]
        body[-1] = body[-1] + ERASE_TO_END

    return HOME + "\n".join(body) + ERASE_TO_END


def write_screen(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def run_demo(t: Theme, hold: float, fps: float) -> None:
    total_steps = len(INSTALL_STEPS)
    frame = 0
    step_idx = 0
    step_progress = 0.0
    tick = 1.0 / fps
    start = time.monotonic()

    sys.stdout.write(HIDE_CURSOR)
    try:
        while step_idx < total_steps:
            elapsed = time.monotonic() - start
            step_progress = min(1.0, (elapsed % 2.8) / 2.2)
            if elapsed > 0 and int(elapsed / 2.8) > step_idx:
                step_idx = min(total_steps - 1, int(elapsed / 2.8))

            key, label = INSTALL_STEPS[step_idx]
            status = f"{label}…"
            subtitle = "github.com/Cookie774-GameDev/VibeSpace"
            write_screen(render_screen(frame, t, step_idx, step_progress, status, subtitle, False))
            frame += 1
            time.sleep(tick)

        # Completion beat
        for i in range(int(fps * 1.2)):
            write_screen(render_screen(frame, t, total_steps - 1, 1.0, "", "", True))
            frame += 1
            time.sleep(tick)

        if hold > 0:
            end = time.monotonic() + hold
            while time.monotonic() < end:
                write_screen(render_screen(frame, t, total_steps - 1, 1.0, "", "", True))
                frame += 1
                time.sleep(tick)
    finally:
        sys.stdout.write(SHOW_CURSOR + RESET)
        sys.stdout.flush()


def read_app_command(app_command: Optional[str], app_file: Optional[str]) -> Optional[str]:
    if app_command:
        return app_command
    if not app_file or not os.path.isfile(app_file):
        return None
    try:
        with open(app_file, encoding="utf-8") as handle:
            value = handle.read().strip()
        return value or None
    except OSError:
        return None


def run_install(
    t: Theme,
    signal_file: Optional[str],
    app_command: Optional[str],
    app_file: Optional[str],
    hold: float,
    fps: float,
) -> None:
    total_steps = len(INSTALL_STEPS)
    frame = 0
    tick = 1.0 / fps
    # Map install time to steps until signal file appears
    start = time.monotonic()
    done = False

    sys.stdout.write(HIDE_CURSOR)
    try:
        while True:
            if signal_file and os.path.isfile(signal_file):
                done = True

            elapsed = time.monotonic() - start
            if done:
                step_idx = total_steps - 1
                step_progress = 1.0
            else:
                # Gentle progression — never claims 100% until signal
                step_idx = min(total_steps - 2, int(elapsed / 4.5))
                step_progress = min(0.92, (elapsed % 4.5) / 3.8)

            key, label = INSTALL_STEPS[step_idx]
            status = "Installing…" if not done else "Ready"
            subtitle = "This window closes when VibeSpace opens"
            write_screen(render_screen(frame, t, step_idx, step_progress, status, subtitle, done))
            frame += 1

            if done:
                break
            time.sleep(tick)

        for i in range(int(fps * 1.5)):
            write_screen(render_screen(frame, t, total_steps - 1, 1.0, "", "", True))
            frame += 1
            time.sleep(tick)

        launch = read_app_command(app_command, app_file)
        if launch:
            try:
                if launch.lower().endswith(".exe") and os.path.isfile(launch):
                    subprocess.Popen(  # noqa: S603
                        [launch],
                        cwd=os.path.dirname(launch) or None,
                    )
                else:
                    subprocess.Popen(launch, shell=True)  # noqa: S602
            except Exception:
                pass

        if hold > 0:
            end = time.monotonic() + hold
            while time.monotonic() < end:
                write_screen(render_screen(frame, t, total_steps - 1, 1.0, "", "", True))
                frame += 1
                time.sleep(tick)
    finally:
        sys.stdout.write(SHOW_CURSOR + RESET + CLEAR)
        sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VibeSpace install splash (download/install only)")
    parser.add_argument(
        "--variant",
        choices=sorted(THEMES.keys()),
        default=DEFAULT_VARIANT if DEFAULT_VARIANT in THEMES else "aurora",
        help="Visual theme (nebula, aurora, prism)",
    )
    parser.add_argument("--demo", action="store_true", help="Loop a preview install animation")
    parser.add_argument("--signal-file", default="", help="When this file exists, finish and launch app")
    parser.add_argument("--app-command", default="", help="Shell command to launch VibeSpace after install")
    parser.add_argument("--app-file", default="", help="Path to file containing exe path or shell command")
    parser.add_argument("--hold", type=float, default=6.0, help="Seconds to hold completion screen")
    parser.add_argument("--fps", type=float, default=18.0, help="Animation frame rate")
    return parser.parse_args()


def main() -> int:
    configure_output()
    enable_ansi_windows()
    args = parse_args()
    theme = THEMES[args.variant]

    if args.demo:
        run_demo(theme, hold=args.hold, fps=args.fps)
        return 0

    run_install(
        theme,
        signal_file=args.signal_file or None,
        app_command=args.app_command or None,
        app_file=args.app_file or None,
        hold=args.hold,
        fps=args.fps,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
