#!/usr/bin/env python3
"""
Jarvis One FOREVER terminal boot launcher
- Keeps loading bars animating while update/start commands run.
- After the app is considered open, switches to JARVIS ONLINE.
- Can keep the online animations running forever until Ctrl+C.

Pure Python. No third-party packages required.
Works best in Windows Terminal / PowerShell / modern terminals with ANSI color support.
"""
from __future__ import annotations

import argparse
import os
import random
import shlex
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

APP_NAME = "JARVIS"
APP_TAG = "ONE"
SUBTITLE = "SYMBIOTE INTEGRATED INTELLIGENCE"
READY_TEXT = "Ready for your command."

# RGB theme
CYAN = (21, 221, 255)
CYAN_2 = (48, 166, 255)
CYAN_DIM = (0, 104, 145)
CYAN_DARK = (0, 62, 90)
AMBER = (255, 174, 44)
AMBER_DIM = (162, 102, 22)
PURPLE = (165, 105, 255)
WHITE = (219, 247, 255)
RED = (255, 72, 72)
GREEN = (91, 255, 157)
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"
CLEAR = "\033[2J\033[H"
HOME = "\033[H"
ERASE_TO_END = "\033[J"

LOGO = [
    r"        ____.    _____       __________    ____   ____  .___  _________",
    r"       |    |   /  _  \      \______   \   \   \ /   /  |   |/   _____/",
    r"       |    |  /  /_\  \      |       _/    \   Y   /   |   |\_____  \ ",
    r"   /\__|    | /    |    \     |    |   \     \     /    |   |/        \ ",
    r"   \________| \____|__  /     |____|_  /      \___/     |___/_______  / ",
    r"                      \/             \/                              \/  ",
]

SMALL_LOGO = [
    r"      __  ___   ____  _   _ ___ ____",
    r"     |  \/  /  / ___|| | | |_ _/ ___|",
    r"     | |\/| | | |    | |_| || |\___ \ ",
    r"     | |  | | | |___ |  _  || | ___) |",
    r"     |_|  |_|  \____||_| |_|___|____/",
    r"              J A R V I S   O N E",
]

FINGERPRINT = [
    "      .-''''-.      ",
    "    .'  .--.  '.    ",
    "   /  .'    '.  \\   ",
    "  |  /  .--.  \\  |  ",
    "  | |  /    \\  | |  ",
    "  | | | .--. | | |  ",
    "   \\ \\ \\__/ / / /   ",
    "    '. '.__.' .'    ",
    "      '-....-'      ",
]

WAVES = [
    "···▁▂▃▅▃▂▁···",
    "··▁▂▅▇▅▂▁····",
    "·▁▃▆█▆▃▁·····",
    "··▂▄▇█▇▄▂····",
    "····▁▂▅▇▅▂▁··",
    "·····▁▃▆█▆▃▁·",
]

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

TASKS = [
    "Initializing Symbiote Core",
    "Loading memory maps",
    "Connecting voice link",
    "Preparing workspace",
    "Calibrating neural mesh",
    "System diagnostics",
]

@dataclass
class StageState:
    label: str = "standing by"
    detail: str = ""
    done: bool = False
    failed: bool = False
    app_started: bool = False
    app_process: Optional[subprocess.Popen] = None
    exit_code: Optional[int] = None


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
    size = shutil.get_terminal_size((128, 38))
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


def run_shell(command: str, cwd: Optional[str], state: StageState, label: str) -> int:
    state.label = label
    state.detail = command
    try:
        proc = subprocess.Popen(
            command,
            cwd=cwd or None,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return proc.wait()
    except Exception as exc:
        state.failed = True
        state.detail = f"{label} failed: {exc}"
        return 1


def start_shell(command: str, cwd: Optional[str], state: StageState, label: str) -> Optional[subprocess.Popen]:
    state.label = label
    state.detail = command
    try:
        proc = subprocess.Popen(
            command,
            cwd=cwd or None,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        state.app_started = True
        state.app_process = proc
        return proc
    except Exception as exc:
        state.failed = True
        state.detail = f"{label} failed: {exc}"
        return None


def process_running_windows(name: str) -> bool:
    if not name:
        return False
    try:
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {name}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        return name.lower() in result.stdout.lower()
    except Exception:
        return False


def wait_for_ready(
    state: StageState,
    process_name: Optional[str],
    ready_file: Optional[str],
    launch_wait_seconds: float,
    timeout: float,
) -> None:
    start = time.time()
    min_end = start + max(0.0, launch_wait_seconds)
    state.label = "launching Jarvis One"
    while True:
        now = time.time()
        if ready_file and os.path.exists(os.path.expandvars(os.path.expanduser(ready_file))):
            state.done = True
            state.label = "Jarvis One ready"
            return
        if process_name and process_running_windows(process_name) and now >= min_end:
            state.done = True
            state.label = "Jarvis One detected"
            return
        if not process_name and not ready_file and now >= min_end:
            state.done = True
            state.label = "Jarvis One launch handoff complete"
            return
        if timeout > 0 and now - start >= timeout:
            state.done = True
            state.label = "launch handoff timed out"
            return
        time.sleep(0.05)


def stage_worker(args: argparse.Namespace, state: StageState) -> None:
    # Demo mode: pretend update and app opening take a few seconds.
    if args.demo or (not args.update_command and not args.app_command):
        state.label = "checking for Jarvis updates"
        state.detail = "demo update check"
        time.sleep(2.5)
        state.label = "applying latest build"
        time.sleep(1.8)
        state.label = "opening Jarvis One"
        time.sleep(max(1.0, args.launch_wait_seconds))
        state.done = True
        state.label = "Jarvis One ready"
        return

    if args.update_command:
        code = run_shell(args.update_command, args.app_cwd, state, "checking for Jarvis updates")
        state.exit_code = code
        if code != 0 and not args.ignore_update_failure:
            state.failed = True
            state.done = True
            state.label = "update failed"
            return

    if args.app_command:
        start_shell(args.app_command, args.app_cwd, state, "opening Jarvis One")
        if state.failed:
            state.done = True
            return
        wait_for_ready(state, args.app_process_name, args.ready_file, args.launch_wait_seconds, args.timeout)
    else:
        state.done = True


def shimmer_bar(frame: int, width: int, fill_char: str = "█") -> str:
    chars: List[str] = []
    hot = frame % max(1, width)
    for i in range(width):
        d = abs(i - hot)
        if d == 0:
            chars.append(rgb(WHITE, fill_char, bold=True))
        elif d <= 2:
            chars.append(rgb(CYAN, fill_char, bold=True))
        elif d <= 5:
            chars.append(rgb(CYAN_2, fill_char))
        else:
            chars.append(rgb(CYAN_DIM, fill_char))
    return "".join(chars)


def completed_bar(width: int, fill_char: str = "█") -> str:
    return "".join(
        rgb(WHITE if i in (0, width - 1) else CYAN, fill_char, bold=True)
        for i in range(width)
    )


def orbit_dots(frame: int, count: int = 22) -> str:
    pieces: List[str] = []
    hot = frame % count
    for i in range(count):
        d = min((i - hot) % count, (hot - i) % count)
        if d == 0:
            pieces.append(rgb(WHITE, "●", bold=True))
        elif d <= 2:
            pieces.append(rgb(CYAN, "●"))
        elif d <= 5:
            pieces.append(rgb(CYAN_2, "•"))
        else:
            pieces.append(rgb(CYAN_DIM, "·", dim=True))
    return " ".join(pieces)


def completed_dots(count: int = 22) -> str:
    return " ".join(rgb(CYAN, "●", bold=i in (0, count - 1)) for i in range(count))


def logo_lines(width: int, frame: int) -> List[str]:
    logo = SMALL_LOGO if width < 94 else LOGO
    colors = [CYAN_DIM, CYAN_2, CYAN, WHITE, CYAN, CYAN_2, CYAN_DIM]
    result = []
    for i, line in enumerate(logo):
        color = colors[(i + frame // 4) % len(colors)]
        result.append(center(rgb(color, line, bold=color in (CYAN, WHITE)), width))
    return result


def wave_stack(frame: int) -> List[str]:
    # Small right-side waveform tower.
    base = [
        "   ···   ▂▄▆▄▂   ··· ",
        "  ···   ▃▅██▅▃   ··· ",
        " ···   ▁▄████▄▁   ···",
        "  ···   ▃▅██▅▃   ··· ",
        "   ···   ▂▄▆▄▂   ··· ",
        "    ···   ▂▄▄▂   ···  ",
    ]
    return [rgb(CYAN_2 if (i + frame) % 3 else CYAN, base[(i + frame) % len(base)]) for i in range(6)]


def render_screen(state: StageState, frame: int, online: bool, forever: bool) -> str:
    width, height = term_size()
    lines: List[str] = []

    cwd = os.getcwd()
    lines.append(rgb(CYAN, f"PS {cwd}> ") + rgb(AMBER, "Jarvis", bold=True))
    lines.append("")
    scan_len = min(width - 10, 106)
    pulse_pos = frame % max(1, scan_len)
    scan = []
    for i in range(scan_len):
        if abs(i - pulse_pos) <= 1:
            scan.append(rgb(WHITE, "═", bold=True))
        elif abs(i - pulse_pos) <= 5:
            scan.append(rgb(CYAN, "─"))
        else:
            scan.append(rgb(CYAN_DIM, "─", dim=True))
    lines.append(center("".join(scan), width))
    lines.append(center(rgb(PURPLE, "╲╱", bold=True), width))
    lines.extend(logo_lines(width, frame))

    subtitle = rgb(CYAN_2, f"───●───  {SUBTITLE}  ───●───")
    tag = rgb(AMBER, f"  {APP_TAG}  ", bold=True) + rgb(AMBER_DIM, "────────")
    if width >= 105:
        lines.append(center(subtitle + "   " + tag, width))
    else:
        lines.append(center(rgb(CYAN_2, SUBTITLE), width))
    lines.append("")

    left_w = 39 if width >= 110 else 30
    bar_w = 38 if width >= 120 else max(18, min(30, width - left_w - 42))
    waves = wave_stack(frame)
    spin = SPINNER[frame % len(SPINNER)]
    for idx, task in enumerate(TASKS):
        active = (frame // 10 + idx) % len(TASKS)
        bullet = rgb(WHITE if active == idx else CYAN, f"[{spin if active == idx else '●'}]", bold=active == idx)
        dots = "." * (3 + ((frame // 6 + idx) % 4))
        label = pad_visible(f"{bullet}  {rgb(CYAN, task + dots, bold=active == idx)}", left_w)
        if idx in (0, 1, 3):
            bar = completed_bar(bar_w) if online else shimmer_bar(frame + idx * 7, bar_w)
            status = rgb(AMBER, "100%" if online else "LOADING", bold=True)
        else:
            dot_count = max(10, bar_w // 2)
            dots_bar = completed_dots(dot_count) if online else orbit_dots(frame + idx * 5, dot_count)
            bar = pad_visible(dots_bar, bar_w)
            status = rgb(AMBER, "OK" if online else "LINKING", bold=True)
        wave = waves[idx % len(waves)] if width >= 110 else ""
        row = f"{label}  {bar}   {pad_visible(status, 8)}   {wave}"
        lines.append(center(row, width))

    lines.append("")
    line_w = min(width - 8, 118)
    side_pos = (frame * 2) % max(1, line_w)
    cyber = []
    for i in range(line_w):
        if i in (8, line_w - 9):
            cyber.append(rgb(CYAN, "●", bold=True))
        elif abs(i - side_pos) <= 2:
            cyber.append(rgb(CYAN, "═"))
        else:
            cyber.append(rgb(CYAN_DIM, "─"))
    lines.append(center("".join(cyber), width))

    panel_w = min(width - 8, 108)
    left_pad = max(0, (width - panel_w) // 2)
    online_title = "J A R V I S   O N L I N E" if online else "J A R V I S   B O O T I N G"
    subtitle_status = "All systems nominal." if online else f"{state.label}"
    detail = state.detail[:70]
    wave_line = "───╼" + "┈" * (18 + (frame % 12)) + "╾───"
    for r in range(max(len(FINGERPRINT), 7)):
        fp = FINGERPRINT[r] if r < len(FINGERPRINT) else " " * len(FINGERPRINT[0])
        fp_color = CYAN if (r + frame // 3) % 4 == 0 else CYAN_DIM
        if r == 1:
            mid = rgb(CYAN_2 if online else CYAN, online_title, bold=True)
        elif r == 2:
            mid = rgb(AMBER, subtitle_status, bold=True)
        elif r == 3 and detail:
            mid = rgb(CYAN_DIM, detail, dim=True)
        elif r == 5:
            mid = rgb(PURPLE, wave_line)
        else:
            mid = ""
        lines.append(" " * left_pad + rgb(fp_color, fp) + rgb(CYAN_DIM, " │ ") + mid)

    ready = "READY" if online else "OPENING"
    if state.failed:
        ready = "ERROR"
    ready_color = RED if state.failed else PURPLE
    ready_line = rgb(AMBER, "─" * 34) + rgb(ready_color, f" ●  {ready}  ● ", bold=True) + rgb(AMBER, "─" * 34)
    lines.append(center(ready_line, width))
    footer = READY_TEXT if online else "Loading bars will continue until Jarvis One opens. Press Ctrl+C to stop."
    if forever and online:
        footer += "  Online animation is running forever."
    lines.append(rgb(CYAN if not state.failed else RED, footer, bold=True))

    # Crop to terminal height while keeping top. Usually enough in 32+ lines.
    if len(lines) > height - 1:
        lines = lines[: height - 1]
    return HOME + "\n".join(lines) + ERASE_TO_END


def animate_until_done(state: StageState, args: argparse.Namespace) -> None:
    frame = 0
    online = False
    min_frame_delay = 0.04 if args.fast else 0.08 if not args.slow else 0.14
    while True:
        if state.done and not online:
            online = True
            # Give a clean transition frame.
        sys.stdout.write(render_screen(state, frame, online, args.forever))
        sys.stdout.flush()
        frame += 1
        if online and not args.forever:
            if args.hold <= 0:
                return
            # keep online animation for hold seconds then exit
            if not hasattr(animate_until_done, "online_started"):
                setattr(animate_until_done, "online_started", time.time())
            if time.time() - getattr(animate_until_done, "online_started") >= args.hold:
                return
        time.sleep(min_frame_delay)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Jarvis One forever terminal boot launcher")
    parser.add_argument("--demo", action="store_true", help="Run a fake update/open demo")
    parser.add_argument("--forever", action="store_true", help="Keep online animations running forever after Jarvis opens")
    parser.add_argument("--hold", type=float, default=3.0, help="Seconds to keep online animation if not using --forever")
    parser.add_argument("--fast", action="store_true", help="Faster animation")
    parser.add_argument("--slow", action="store_true", help="Slower animation")
    parser.add_argument("--no-clear", action="store_true", help="Do not clear terminal")
    parser.add_argument("--update-command", default="", help="Command to check/pull/install updates before launching")
    parser.add_argument("--ignore-update-failure", action="store_true", help="Continue launching even if update command fails")
    parser.add_argument("--app-command", default="", help="Command to launch the real Jarvis app. Do NOT set this to Jarvis or it will recurse.")
    parser.add_argument("--app-cwd", default="", help="Working directory for update/app commands")
    parser.add_argument("--app-process-name", default="", help="Windows process name to wait for, example Jarvis-One.exe")
    parser.add_argument("--ready-file", default="", help="File path created by the app when fully loaded")
    parser.add_argument("--launch-wait-seconds", type=float, default=5.0, help="Minimum seconds to animate after launching app")
    parser.add_argument("--timeout", type=float, default=60.0, help="Max seconds to wait for process/ready-file. 0 = no timeout")
    args = parser.parse_args(argv)

    configure_output()
    enable_ansi_windows()
    state = StageState(label="standing by")

    try:
        sys.stdout.write(HIDE_CURSOR)
        if not args.no_clear:
            sys.stdout.write(CLEAR)
        worker = threading.Thread(target=stage_worker, args=(args, state), daemon=True)
        worker.start()
        animate_until_done(state, args)
        return 1 if state.failed else 0
    except KeyboardInterrupt:
        sys.stdout.write("\n" + rgb(AMBER, "Jarvis terminal animation stopped.") + "\n")
        return 130
    finally:
        sys.stdout.write(SHOW_CURSOR + RESET)
        sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
