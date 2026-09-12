"""Authenticated, bounded cloud-to-desktop read relay.

The desktop opens the WebSocket, authenticates with its Supabase JWT, and
advertises only the read tools available for an explicitly granted project.
No local absolute root is sent to this service. Every call is session-bound,
monotonic, short-lived, size-bounded, and correlated with exactly one result.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket

log = logging.getLogger(__name__)

BRIDGE_PROTOCOL_VERSION = 2
SAFE_READ_TOOLS = frozenset({"fs.read", "fs.list"})
MAX_ARGUMENT_BYTES = 64 * 1024
MAX_RESULT_BYTES = 256 * 1024
MAX_DEADLINE_MS = 30_000
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{12,96}$")


@dataclass(frozen=True)
class BridgeRegistration:
    protocol_version: int
    client_nonce: str
    workspace_grant_id: str
    workspace_display_name: str
    tools_schema: tuple[dict, ...]
    tool_names: frozenset[str]


@dataclass(frozen=True)
class ValidatedToolRequest:
    tool_name: str
    args: dict
    deadline_ms: int


@dataclass
class PendingCall:
    future: asyncio.Future
    sequence: int


@dataclass
class BridgeSession:
    """One authenticated outbound desktop connection."""

    session_id: str
    user_id: str
    ws: WebSocket
    tools_schema: list[dict]
    tool_names: frozenset[str]
    client_nonce: str
    server_nonce: str
    workspace_grant_id: str
    workspace_display_name: str
    daemon_version: Optional[str] = None
    platform: Optional[str] = None
    pending: dict[str, PendingCall] = field(default_factory=dict)
    next_sequence: int = 1
    connected_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)


def _is_plain_dict(value: object) -> bool:
    return isinstance(value, dict)


def _encoded_size(value: object) -> int:
    try:
        return len(
            json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("payload is not JSON serializable") from exc


def _validate_tool_schema(raw: object) -> tuple[list[dict], frozenset[str]]:
    if not isinstance(raw, list) or len(raw) > len(SAFE_READ_TOOLS):
        raise ValueError("invalid tool catalog")
    schemas: list[dict] = []
    names: set[str] = set()
    for item in raw:
        if not _is_plain_dict(item) or item.get("type") != "function":
            raise ValueError("invalid tool schema")
        function = item.get("function")
        if not _is_plain_dict(function):
            raise ValueError("invalid tool schema")
        name = function.get("name")
        description = function.get("description")
        parameters = function.get("parameters")
        if name not in SAFE_READ_TOOLS or name in names:
            raise ValueError("unapproved or duplicate tool")
        if (
            not isinstance(description, str)
            or not description
            or len(description) > 500
        ):
            raise ValueError("invalid tool description")
        if not _is_plain_dict(parameters) or parameters.get("type") != "object":
            raise ValueError("invalid tool parameters")
        if _encoded_size(item) > 8 * 1024:
            raise ValueError("tool schema too large")
        schemas.append(item)
        names.add(name)
    return schemas, frozenset(names)


def validate_registration_frame(frame: object) -> BridgeRegistration:
    if not _is_plain_dict(frame) or frame.get("kind") != "register":
        raise ValueError("invalid registration")
    if frame.get("protocol_version") != BRIDGE_PROTOCOL_VERSION:
        raise ValueError("unsupported bridge protocol")
    client_nonce = frame.get("client_nonce")
    if not isinstance(client_nonce, str) or not SAFE_IDENTIFIER.fullmatch(client_nonce):
        raise ValueError("invalid client nonce")
    if frame.get("writable") is not False or frame.get("shell_enabled") is not False:
        raise ValueError("bridge must be read-only")
    tools_schema, tool_names = _validate_tool_schema(frame.get("tools"))
    workspace_grant = frame.get("workspace_grant")
    if not _is_plain_dict(workspace_grant):
        raise ValueError("missing workspace grant")
    workspace_grant_id = workspace_grant.get("id")
    workspace_display_name = workspace_grant.get("display_name")
    if (
        not isinstance(workspace_grant_id, str)
        or not SAFE_IDENTIFIER.fullmatch(workspace_grant_id)
        or not isinstance(workspace_display_name, str)
        or not workspace_display_name.strip()
        or len(workspace_display_name.strip()) > 120
        or any(ord(char) < 32 or ord(char) == 127 for char in workspace_display_name)
    ):
        raise ValueError("invalid workspace grant")
    return BridgeRegistration(
        protocol_version=BRIDGE_PROTOCOL_VERSION,
        client_nonce=client_nonce,
        workspace_grant_id=workspace_grant_id,
        workspace_display_name=workspace_display_name.strip(),
        tools_schema=tuple(tools_schema),
        tool_names=tool_names,
    )


def validate_tool_request(
    *,
    tool_name: object,
    args: object,
    deadline_ms: object,
    advertised_tools: frozenset[str],
) -> ValidatedToolRequest:
    if not isinstance(tool_name, str) or tool_name not in advertised_tools:
        raise ValueError("tool was not advertised")
    if tool_name not in SAFE_READ_TOOLS:
        raise ValueError("tool is not allowed")
    if not _is_plain_dict(args):
        raise ValueError("invalid tool arguments")
    if _encoded_size(args) > MAX_ARGUMENT_BYTES:
        raise ValueError("tool arguments are too large")
    if (
        not isinstance(deadline_ms, int)
        or isinstance(deadline_ms, bool)
        or deadline_ms < 100
        or deadline_ms > MAX_DEADLINE_MS
    ):
        raise ValueError("invalid tool deadline")
    return ValidatedToolRequest(tool_name=tool_name, args=args, deadline_ms=deadline_ms)


class BridgeRegistry:
    """Singleton holding the current outbound desktop bridge per user."""

    def __init__(self) -> None:
        self._by_user: dict[str, BridgeSession] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        ws: WebSocket,
        user_id: str,
        registration: BridgeRegistration,
        daemon_version: Optional[str],
        platform: Optional[str],
    ) -> BridgeSession:
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

            session = BridgeSession(
                session_id=f"br_{uuid4().hex[:16]}",
                user_id=user_id,
                ws=ws,
                tools_schema=list(registration.tools_schema),
                tool_names=registration.tool_names,
                client_nonce=registration.client_nonce,
                server_nonce=f"nonce_{uuid4().hex}",
                workspace_grant_id=registration.workspace_grant_id,
                workspace_display_name=registration.workspace_display_name,
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
                log.info(
                    "deregistered %s (user=%s, reason=%s)",
                    session.session_id,
                    session.user_id,
                    reason,
                )
            for pending in session.pending.values():
                if not pending.future.done():
                    pending.future.set_exception(RuntimeError("bridge_disconnected"))
            session.pending.clear()

    def is_connected(self, user_id: str) -> bool:
        return user_id in self._by_user

    def get_session(self, user_id: str) -> Optional[BridgeSession]:
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
        del require_confirm, require_unlock, unlock_active
        session = self._by_user.get(user_id)
        if not session:
            raise RuntimeError("bridge_offline")
        request = validate_tool_request(
            tool_name=tool_name,
            args=args,
            deadline_ms=deadline_ms,
            advertised_tools=session.tool_names,
        )

        call_id_unique = f"tc_{uuid4().hex[:12]}"
        sequence = session.next_sequence
        session.next_sequence += 1
        now_ms = int(time.time() * 1000)
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        session.pending[call_id_unique] = PendingCall(future=future, sequence=sequence)
        frame = {
            "kind": "tool_call",
            "session_id": session.session_id,
            "call_id": call_id_unique,
            "parent_call_id": str(call_id)[:96],
            "name": request.tool_name,
            "args": request.args,
            "sequence": sequence,
            "issued_at_ms": now_ms,
            "expires_at_ms": now_ms + request.deadline_ms,
            "deadline_ms": request.deadline_ms,
        }

        try:
            await session.ws.send_text(json.dumps(frame, separators=(",", ":")))
        except Exception as exc:
            session.pending.pop(call_id_unique, None)
            raise RuntimeError("bridge_send_failed") from exc

        try:
            return await asyncio.wait_for(future, timeout=request.deadline_ms / 1000.0)
        except asyncio.TimeoutError:
            raise RuntimeError("bridge_timeout") from None
        finally:
            session.pending.pop(call_id_unique, None)

    async def handle_frame(self, session: BridgeSession, frame: dict) -> None:
        kind = frame.get("kind")
        if kind == "tool_result":
            if frame.get("session_id") != session.session_id:
                return
            call_id = frame.get("call_id")
            pending = session.pending.get(call_id) if isinstance(call_id, str) else None
            if (
                not pending
                or pending.future.done()
                or frame.get("sequence") != pending.sequence
            ):
                return
            if _encoded_size(frame) > MAX_RESULT_BYTES:
                pending.future.set_exception(RuntimeError("tool_result_too_large"))
            elif frame.get("ok") is True:
                pending.future.set_result(frame.get("result"))
            else:
                pending.future.set_exception(RuntimeError("local_read_denied"))
        elif kind == "heartbeat":
            session.last_heartbeat = time.time()
            try:
                await session.ws.send_text(
                    json.dumps({"kind": "heartbeat", "ts": int(time.time() * 1000)})
                )
            except Exception:
                pass
        elif kind == "deregister":
            log.info("daemon %s sent deregister", session.session_id)
        else:
            log.warning("unknown bridge frame kind")


_browser_chat_registry: Optional[BridgeRegistry] = None


def get_browser_chat_bridge_registry() -> BridgeRegistry:
    global _browser_chat_registry
    if _browser_chat_registry is None:
        _browser_chat_registry = BridgeRegistry()
    return _browser_chat_registry


def get_bridge_registry():
    """Return the compatibility Phone/Voice registry.

    Kept under the historical export so the call pipelines retain their
    existing behavior while Browser Chat uses its isolated registry.
    """

    from .phone_bridge import get_phone_bridge_registry

    return get_phone_bridge_registry()
