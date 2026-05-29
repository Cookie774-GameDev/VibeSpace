"""
Audit logger — JSONL files, one record per substantive event.

Two streams:
1. Per-call file at audit/<YYYY-MM-DD>/<call_id>.jsonl - fine-grained
2. Daily rollup at audit/<YYYY-MM-DD>.jsonl - one line per call summary

Both rotated daily. Default retention 30 days (configurable via env).

We DO NOT store raw tool results (file contents). Only summaries:
  byte_count, line_count, truncated, sha256_prefix.

In production you'd ALSO upload the daily rollup to Supabase `call_audit`
table for cross-device viewing. This module writes locally; the Supabase
sync is in main.py's daily task.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from .config import get_settings

log = logging.getLogger(__name__)


@dataclass
class CallAuditRecord:
    """One call's worth of metadata for the daily rollup."""

    call_id: str
    user_id: str
    transport: str  # "twilio" | "livekit"
    caller_number: Optional[str]
    started_at: str  # ISO 8601 UTC
    ended_at: Optional[str] = None
    end_reason: Optional[str] = None  # "user_hangup" | "ai_hangup" | "idle" | "cost_cap" | "error"
    duration_ms: int = 0
    turn_count: int = 0
    tool_call_count: int = 0
    pin_attempts: int = 0
    pin_passed: bool = False
    cost_estimate_usd: float = 0.0
    persona: str = "sage"


@dataclass
class TurnAuditRecord:
    """One conversational turn (user utterance -> AI reply)."""

    ts: str
    call_id: str
    turn_id: int
    user_transcript: str = ""
    stt_latency_ms: int = 0
    llm_first_token_ms: int = 0
    tool_calls: list[dict] = field(default_factory=list)
    agent_text: str = ""
    tts_first_byte_ms: int = 0
    total_turn_ms: int = 0


def summarize_tool_result(result: Any) -> dict:
    """Reduce a tool result to safe metadata for the audit log."""
    if result is None:
        return {"size": 0, "truncated": False}
    try:
        as_str = json.dumps(result) if not isinstance(result, str) else result
    except (TypeError, ValueError):
        as_str = str(result)
    raw = as_str.encode("utf-8", errors="replace")
    sha = hashlib.sha256(raw).hexdigest()[:16]
    return {
        "size": len(raw),
        "lines": as_str.count("\n") + 1 if as_str else 0,
        "truncated": isinstance(result, dict) and bool(result.get("truncated")),
        "sha256_16": sha,
    }


class AuditLogger:
    """Writes per-call and daily-rollup JSONL files to a local directory."""

    def __init__(self, base_dir: Optional[str] = None) -> None:
        self.base_dir = Path(base_dir or os.environ.get("AUDIT_DIR", "audit"))
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._call_records: dict[str, CallAuditRecord] = {}
        self._lock = asyncio.Lock()

    def _today_dir(self) -> Path:
        d = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        out = self.base_dir / d
        out.mkdir(parents=True, exist_ok=True)
        return out

    def _rollup_path(self) -> Path:
        d = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self.base_dir / f"{d}.jsonl"

    def _call_path(self, call_id: str) -> Path:
        return self._today_dir() / f"{call_id}.jsonl"

    async def log_call_start(
        self,
        call_id: str,
        user_id: str,
        transport: str,
        caller_number: Optional[str],
        persona: str = "sage",
    ) -> None:
        async with self._lock:
            rec = CallAuditRecord(
                call_id=call_id,
                user_id=user_id,
                transport=transport,
                caller_number=caller_number,
                started_at=datetime.now(timezone.utc).isoformat(),
                persona=persona,
            )
            self._call_records[call_id] = rec
            await self._append(self._call_path(call_id), {"event": "call_start", **asdict(rec)})

    async def log_pin_attempt(self, call_id: str, success: bool) -> None:
        async with self._lock:
            rec = self._call_records.get(call_id)
            if rec:
                rec.pin_attempts += 1
                if success:
                    rec.pin_passed = True
            await self._append(
                self._call_path(call_id),
                {
                    "event": "pin_attempt",
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "success": success,
                },
            )

    async def log_turn(self, turn: TurnAuditRecord) -> None:
        async with self._lock:
            rec = self._call_records.get(turn.call_id)
            if rec:
                rec.turn_count += 1
                rec.tool_call_count += len(turn.tool_calls)
            await self._append(self._call_path(turn.call_id), {"event": "turn", **asdict(turn)})

    async def log_tool_call(
        self,
        call_id: str,
        name: str,
        args: dict,
        result: Any,
        ok: bool,
        elapsed_ms: int,
    ) -> None:
        summary = summarize_tool_result(result) if ok else {"error": str(result)}
        async with self._lock:
            await self._append(
                self._call_path(call_id),
                {
                    "event": "tool_call",
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "name": name,
                    "args": args,
                    "ok": ok,
                    "elapsed_ms": elapsed_ms,
                    "result_summary": summary,
                },
            )

    async def log_call_end(
        self,
        call_id: str,
        end_reason: str,
        cost_estimate_usd: float = 0.0,
    ) -> None:
        async with self._lock:
            rec = self._call_records.get(call_id)
            if not rec:
                return
            rec.ended_at = datetime.now(timezone.utc).isoformat()
            rec.end_reason = end_reason
            rec.cost_estimate_usd = round(cost_estimate_usd, 4)
            try:
                started = datetime.fromisoformat(rec.started_at)
                ended = datetime.fromisoformat(rec.ended_at)
                rec.duration_ms = int((ended - started).total_seconds() * 1000)
            except Exception:
                pass
            await self._append(self._call_path(call_id), {"event": "call_end", **asdict(rec)})
            await self._append(self._rollup_path(), asdict(rec))
            self._call_records.pop(call_id, None)

    async def _append(self, path: Path, record: dict) -> None:
        try:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as e:
            log.error("audit write failed: %s", e)

    async def prune_old(self) -> int:
        """Delete audit files older than AUDIT_RETENTION_DAYS. Returns count."""
        s = get_settings()
        cutoff = datetime.now(timezone.utc) - timedelta(days=s.AUDIT_RETENTION_DAYS)
        removed = 0
        for entry in self.base_dir.iterdir():
            try:
                # Match either YYYY-MM-DD/ dir or YYYY-MM-DD.jsonl rollup
                name = entry.stem if entry.is_file() else entry.name
                d = datetime.strptime(name, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                if d < cutoff:
                    if entry.is_file():
                        entry.unlink()
                    else:
                        for f in entry.iterdir():
                            f.unlink()
                        entry.rmdir()
                    removed += 1
            except (ValueError, OSError):
                continue
        return removed


_logger: Optional[AuditLogger] = None


def get_audit_logger() -> AuditLogger:
    global _logger
    if _logger is None:
        _logger = AuditLogger()
    return _logger
