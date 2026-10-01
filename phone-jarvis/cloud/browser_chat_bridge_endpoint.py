"""Authenticated read-only Browser Chat device-relay WebSocket endpoint."""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .auth import get_jwt_verifier
from .bridge import (
    BRIDGE_PROTOCOL_VERSION,
    get_browser_chat_bridge_registry,
    validate_registration_frame,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="", tags=["browser-chat-bridge"])


@router.websocket("/browser-chat/bridge")
async def browser_chat_bridge_endpoint(websocket: WebSocket):
    await websocket.accept()
    bridge = get_browser_chat_bridge_registry()
    session = None
    try:
        first = await websocket.receive_json()
        token = first.get("token") if isinstance(first, dict) else None
        if not token:
            await websocket.close(code=4003, reason="missing token")
            return
        try:
            claims = await get_jwt_verifier().verify(token)
            registration = validate_registration_frame(first)
        except PermissionError:
            await websocket.close(code=4003, reason="auth_failed")
            return
        except ValueError:
            await websocket.close(code=4002, reason="invalid registration")
            return
        user_id = claims.get("sub")
        if not isinstance(user_id, str) or not user_id:
            await websocket.close(code=4003, reason="no sub claim")
            return

        session = await bridge.register(
            ws=websocket,
            user_id=user_id,
            registration=registration,
            daemon_version=first.get("daemon_version"),
            platform=first.get("platform"),
        )
        await websocket.send_text(
            json.dumps(
                {
                    "kind": "registered",
                    "protocol_version": BRIDGE_PROTOCOL_VERSION,
                    "session_id": session.session_id,
                    "server_nonce": session.server_nonce,
                    "server_time": int(time.time() * 1000),
                },
                separators=(",", ":"),
            )
        )
        while True:
            try:
                frame = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            if isinstance(frame, dict):
                await bridge.handle_frame(session, frame)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("Browser Chat bridge endpoint failed")
        try:
            await websocket.close(code=1011, reason="bridge_error")
        except Exception:
            pass
    finally:
        if session:
            await bridge.deregister(session, reason="ws_closed")
