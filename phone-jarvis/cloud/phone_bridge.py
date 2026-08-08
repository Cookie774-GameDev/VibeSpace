"""Compatibility registry for the existing Phone/Voice desktop tool bridge.

Browser Chat never uses this registry. Its narrower read-only protocol lives
in ``bridge.py`` and has a separate WebSocket endpoint and session map.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket

log = logging.getLogger(__name__)


@dataclass
class PhoneBridgeSession:
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


class PhoneBridgeRegistry:
    """Original Phone/Voice tool registry, isolated from Browser Chat."""

    def __init__(self) -> None:
        self._by_user: dict[str, PhoneBridgeSession] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        ws: WebSocket,
        user_id: str,
        tools_schema: list[dict],
        workspace_root: Optional[str],
        daemon_version: Optional[str],
        platform: Optional[str],
    ) -> PhoneBridgeSession:
        async with self._lock:
            existing = self._by_user.get(user_id)
            if existing:
                log.info(
                    "user %s reconnected; closing prior session %s",
                    user_id,
                    existing.session_id,
                )
                try:
                    await existing.ws.close(code=4001, reason="superseded")
                except Exception:
                    pass
            session = PhoneBridgeSession(
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

    async def deregister(
        self, session: PhoneBridgeSession, reason: str = "closed"
    ) -> None:
        async with self._lock:
            current = self._by_user.get(session.user_id)
            if current and current.session_id == session.session_id:
                self._by_user.pop(session.user_id, None)
                log.info(
                    "deregistered %s (user=%s, reason=%s)",
                    session.session_id,
                    session.user_id,
                    reason,
                )
            for future in session.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError(f"bridge_disconnected: {reason}"))
            session.pending.clear()

    def is_connected(self, user_id: str) -> bool:
        return user_id in self._by_user

    def get_session(self, user_id: str) -> Optional[PhoneBridgeSession]:
        return self._by_user.get(user_id)

    def get_tools_schema(self, user_id: str) -> list[dict]:
        session = self._by_user.get(user_id)
        return list(session.tools_schema) if session else []

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
        session = self._by_user.get(user_id)
        if not session:
            raise RuntimeError("bridge_offline")
        if require_unlock and not unlock_active:
            return {
                "error": "unlock_required",
                "message": "Shell tools require the unlock phrase first. Say 'unlock shell' if you want this.",
            }

        call_id_unique = f"tc_{uuid4().hex[:12]}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        session.pending[call_id_unique] = future
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
        except Exception as error:
            session.pending.pop(call_id_unique, None)
            raise RuntimeError(f"bridge_send_failed: {error}") from error

        try:
            return await asyncio.wait_for(future, timeout=deadline_ms / 1000.0)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"bridge_timeout: {tool_name} exceeded {deadline_ms}ms"
            ) from None
        finally:
            session.pending.pop(call_id_unique, None)

    async def handle_frame(self, session: PhoneBridgeSession, frame: dict) -> None:
        kind = frame.get("kind")
        if kind == "tool_result":
            call_id = frame.get("call_id")
            future = session.pending.get(call_id) if call_id else None
            if future and not future.done():
                if frame.get("ok"):
                    future.set_result(frame.get("result"))
                else:
                    error = frame.get("error", {})
                    future.set_exception(
                        RuntimeError(
                            f"{error.get('code', 'tool_error')}: "
                            f"{error.get('message', 'unknown')}"
                        )
                    )
        elif kind == "heartbeat":
            session.last_heartbeat = time.time()
            try:
                await session.ws.send_text(
                    json.dumps({"kind": "heartbeat", "ts": int(time.time() * 1000)})
                )
            except Exception:
                pass
        elif kind == "deregister":
            log.info(
                "daemon %s sent deregister: %s",
                session.session_id,
                frame.get("reason"),
            )
        else:
            log.warning("unknown frame kind: %s", kind)


_registry: Optional[PhoneBridgeRegistry] = None


def get_phone_bridge_registry() -> PhoneBridgeRegistry:
    global _registry
    if _registry is None:
        _registry = PhoneBridgeRegistry()
    return _registry
