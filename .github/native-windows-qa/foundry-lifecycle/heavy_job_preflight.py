"""Cheap Windows RAM admission check. A PASS is not a coordinator grant.

Run immediately before a granted heavy command and stop on nonzero exit.
Other reservation arguments are additional *future* demand, not memory already
charged to Windows. The coordinator supplies them from its current queue.
"""
import argparse
import ctypes
import json
import math
import sys
from datetime import datetime, timezone


def decide(available_mib, commit_available_mib, peak_mib, commit_peak_mib,
           reserved_growth_mib, reserved_commit_mib):
    values = [available_mib, commit_available_mib, peak_mib, commit_peak_mib,
              reserved_growth_mib, reserved_commit_mib]
    if any(not math.isfinite(x) or x < 0 for x in values):
        raise ValueError("Memory values must be finite and nonnegative")
    if peak_mib <= 0 or commit_peak_mib <= 0:
        raise ValueError("Unknown/zero job estimates cannot be admitted")
    reserve_mib = 1024
    ram_needed = math.ceil(peak_mib * 1.25 + reserved_growth_mib + reserve_mib)
    commit_needed = math.ceil(commit_peak_mib * 1.25 + reserved_commit_mib + reserve_mib)
    reasons = []
    if available_mib < ram_needed:
        reasons.append("insufficient_available_ram")
    if commit_available_mib < commit_needed:
        reasons.append("insufficient_commit_headroom")
    return {"admitted": not reasons, "reasons": reasons,
            "availableMiB": available_mib, "requiredAvailableMiB": ram_needed,
            "commitAvailableMiB": commit_available_mib,
            "requiredCommitAvailableMiB": commit_needed,
            "reserveMiB": reserve_mib, "estimateMultiplier": 1.25}


def windows_memory():
    if sys.platform != "win32":
        raise RuntimeError("Windows-only helper; use verified platform telemetry elsewhere")
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in
            ("totalPhys", "availPhys", "totalPageFile", "availPageFile",
             "totalVirtual", "availVirtual", "availExtendedVirtual")]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError("GlobalMemoryStatusEx failed")
    return status.availPhys / 1048576, status.availPageFile / 1048576


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--peak-mib", type=float, required=True)
    parser.add_argument("--commit-peak-mib", type=float, required=True)
    parser.add_argument("--reserved-growth-mib", type=float, required=True)
    parser.add_argument("--reserved-commit-mib", type=float, required=True)
    args = parser.parse_args()
    try:
        available, commit_available = windows_memory()
        result = decide(available, commit_available, args.peak_mib,
                        args.commit_peak_mib, args.reserved_growth_mib,
                        args.reserved_commit_mib)
        result["observedAtUtc"] = datetime.now(timezone.utc).isoformat()
        result["scope"] = "RAM and commit only; separate grant/output/disk/VRAM checks required"
        print(json.dumps(result))
        return 0 if result["admitted"] else 2
    except (ValueError, RuntimeError, OSError) as exc:
        print(json.dumps({"admitted": False, "error": str(exc)}))
        return 3


if __name__ == "__main__":
    sys.exit(main())
