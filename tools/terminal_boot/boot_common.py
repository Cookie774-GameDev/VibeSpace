"""Shared ANSI terminal helpers for VibeSpace boot / install splash scripts."""
from __future__ import annotations

import os
import shutil
import sys
from typing import Tuple

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"
CLEAR = "\033[2J\033[H"
HOME = "\033[H"
ERASE_TO_END = "\033[J"


def enable_ansi_windows() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes  # type: ignore

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def configure_output() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def rgb(color: Tuple[int, int, int], text: str, bold: bool = False, dim: bool = False) -> str:
    prefix = ""
    if bold:
        prefix += BOLD
    if dim:
        prefix += DIM
    r, g, b = color
    return f"{prefix}\033[38;2;{r};{g};{b}m{text}{RESET}"


def strip_ansi_len(text: str) -> int:
    n = 0
    i = 0
    while i < len(text):
        if text[i] == "\033" and i + 1 < len(text) and text[i + 1] == "[":
            i += 2
            while i < len(text) and text[i] not in "mHJKABCD?hlfsu":
                i += 1
            i += 1
        else:
            n += 1
            i += 1
    return n


def term_size() -> Tuple[int, int]:
    size = shutil.get_terminal_size((120, 36))
    return size.columns, size.lines


def center(text: str, width: int) -> str:
    visible = strip_ansi_len(text)
    if visible >= width:
        return text
    return " " * ((width - visible) // 2) + text


def pad_visible(text: str, width: int) -> str:
    visible = strip_ansi_len(text)
    if visible >= width:
        return text
    return text + " " * (width - visible)


def shimmer_bar(frame: int, width: int, hot: Tuple[int, int, int], mid: Tuple[int, int, int], dim: Tuple[int, int, int], peak: Tuple[int, int, int]) -> str:
    chars: list[str] = []
    hot_idx = frame % max(1, width)
    for i in range(width):
        d = abs(i - hot_idx)
        if d == 0:
            chars.append(rgb(peak, "█", bold=True))
        elif d <= 2:
            chars.append(rgb(hot, "█", bold=True))
        elif d <= 5:
            chars.append(rgb(mid, "█"))
        else:
            chars.append(rgb(dim, "█"))
    return "".join(chars)


def orbit_dots(frame: int, count: int, hot: Tuple[int, int, int], mid: Tuple[int, int, int], dim: Tuple[int, int, int]) -> str:
    pieces: list[str] = []
    hot_idx = frame % count
    for i in range(count):
        d = min((i - hot_idx) % count, (hot_idx - i) % count)
        if d == 0:
            pieces.append(rgb(hot, "●", bold=True))
        elif d <= 2:
            pieces.append(rgb(mid, "●"))
        elif d <= 5:
            pieces.append(rgb(mid, "•"))
        else:
            pieces.append(rgb(dim, "·", dim=True))
    return " ".join(pieces)
