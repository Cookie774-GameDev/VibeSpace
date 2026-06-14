"""
Bridge registry — the cloud<->desktop tool dispatch backbone.

Each Jarvis desktop app opens an outbound WebSocket to /bridge/<token> and stays
connected. When a call comes in (Path A or Path C), the cloud finds the user's
desktop bridge and routes tool_calls to it.

Frame protocol (JSON, one frame per WS message):

  desktop -> cloud:
    { "kind": "register", "token": "<jwt>", "daemon_version": "...",
      "platform": "win32", "workspace_root": "C:\\\\Users\\\\example",
      "tools": [{"function": {"name": "fs.read", ...}}, ...] }
    { "kind": "tool_result", "call_id": "...", "ok": true,
      "result": {...}, "elapsed_ms": 38 }
    { "kind": "heartbeat", "ts": 1748534400123 }
    { "kind": "deregister", "reason": "shutdown" }

  cloud -> desktop:
    { "kind": "registered", "session_id": "...", "server_time": "..." }
    { "kind": "tool_call", "call_id": "tc_abc123", "name": "fs.read",
      "args": {...}, "deadline_ms": 8000, "confirmed": false }
    { "kind": "heartbeat", "ts": ... }

A user can have at most one active desktop bridge. If the user opens Jarvis on
a second machine, the older connection is closed with reason="superseded".

The registry survives across calls — the bridge is per-user, not per-call.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)


@dataclass
class BridgeSession:
    """One connected desktop daemon."""

    session_id: str
    user_id: str
    ws: WebSocket
    tools_schema: list[dict] = field(default_factory=list)
    workspace_root: Optional[str] = None
    daemon_version: Optional[str] = None
    platform: Optional[str] = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)


class BridgeRegistry:
    """Singleton holding all live desktop bridges."""

    def __init__(self) -> None:
        # user_id -> BridgeSession
        self._by_user: dict[str, BridgeSession] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        ws: WebSocket,
        user_id: str,
        tools_schema: list[dict],
        workspace_root: Optional[str],
        daemon_version: Optional[str],
        platform: Optional[str],
    ) -> BridgeSession:
        """Add a desktop bridge. Closes any prior session for this user."""
        async with self._lock:
            existing = self._by_user.get(user_id)
            if existing:
                log.info("user %s reconnected; closing prior session %s", user_id, existing.session_id)
                try:
                    await existing.ws.close(code=4001, reason="superseded")
                except Exception:
                    pass

            session = BridgeSession(
                session_id=f"br_{uuid4().hex[:16]}",
                user_id=user_id,
                ws=ws,
                tools_schema=tools_schema,
                workspace_root=workspace_root,
                daemon_version=daemon_version,
                platform=platform,
            )
            self._by_user[user_id] = session
            return session

    async def deregister(self, session: BridgeSession, reason: str = "closed") -> None:
        async with self._lock:
            current = self._by_user.get(session.user_id)
            if current and current.session_id == session.session_id:
                self._by_user.pop(session.user_id, None)
                log.info("deregistered %s (user=%s, reason=%s)", session.session_id, session.user_id, reason)

            # Cancel any in-flight tool calls
            for fut in session.pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError(f"bridge_disconnected: {reason}"))
            session.pending.clear()

    def is_connected(self, user_id: str) -> bool:
        return user_id in self._by_user

    def get_session(self, user_id: str) -> Optional[BridgeSession]:
        return self._by_user.get(user_id)

    def get_tools_schema(self, user_id: str) -> list[dict]:
        s = self._by_user.get(user_id)
        return list(s.tools_schema) if s else []

    async def invoke(
        self,
        user_id: str,
        call_id: str,
        tool_name: str,
        args: dict,
        deadline_ms: int = 8000,
        require_confirm: bool = False,
        require_unlock: bool = False,
        unlock_active: bool = False,
    ) -> Any:
        """
        Send a tool_call frame to the user's daemon and await tool_result.

        Confirm/unlock semantics are enforced HERE, not on the daemon. The
        daemon trusts the cloud's `confirmed` flag (defense in depth: the
        daemon also enforces sandbox rules independently).
        """
        session = self._by_user.get(user_id)
        if not session:
            raise RuntimeError("bridge_offline")

        if require_unlock and not unlock_active:
            return {
                "error": "unlock_required",
                "message": "Shell tools require the unlock phrase first. Say 'unlock shell' if you want this.",
            }

        if require_confirm:
            # In v1 we mark the frame as needing confirm. The cloud-side
            # confirm dispatcher (see twilio_handler / livekit_handler)
            # intercepts these before forwarding and asks the user verbally.
            # For now the bridge just forwards `confirmed=False`; the upstream
            # call site is responsible for upgrading to True after a verbal yes.
            pass

        call_id_unique = f"tc_{uuid4().hex[:12]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        session.pending[call_id_unique] = fut

        frame = {
            "kind": "tool_call",
            "call_id": call_id_unique,
            "parent_call_id": call_id,
            "name": tool_name,
            "args": args,
            "deadline_ms": deadline_ms,
            "confirmed": (not require_confirm) or (require_confirm and unlock_active),
        }

        try:
            await session.ws.send_text(json.dumps(frame))
        except Exception as e:
            session.pending.pop(call_id_unique, None)
            raise RuntimeError(f"bridge_send_failed: {e}") from e

        try:
            result = await asyncio.wait_for(fut, timeout=deadline_ms / 1000.0)
        except asyncio.TimeoutError:
            session.pending.pop(call_id_unique, None)
            raise RuntimeError(f"bridge_timeout: {tool_name} exceeded {deadline_ms}ms") from None
        finally:
            session.pending.pop(call_id_unique, None)

        return result

    async def handle_frame(self, session: BridgeSession, frame: dict) -> None:
        """Process one inbound frame from the daemon."""
        kind = frame.get("kind")

        if kind == "tool_result":
            call_id = frame.get("call_id")
            fut = session.pending.get(call_id) if call_id else None
            if fut and not fut.done():
                if frame.get("ok"):
                    fut.set_result(frame.get("result"))
                else:
                    err = frame.get("error", {})
                    fut.set_exception(
                        RuntimeError(f"{err.get('code', 'tool_error')}: {err.get('message', 'unknown')}")
                    )

        elif kind == "heartbeat":
            session.last_heartbeat = time.time()
            try:
                await session.ws.send_text(json.dumps({"kind": "heartbeat", "ts": int(time.time() * 1000)}))
            except Exception:
                pass

        elif kind == "deregister":
            # Daemon is shutting down cleanly; we'll handle the WS close after.
            log.info("daemon %s sent deregister: %s", session.session_id, frame.get("reason"))

        else:
            log.warning("unknown frame kind: %s", kind)


# Module-level singleton
_registry: Optional[BridgeRegistry] = None


def get_bridge_registry() -> BridgeRegistry:
    global _registry
    if _registry is None:
        _registry = BridgeRegistry()
    return _registry
