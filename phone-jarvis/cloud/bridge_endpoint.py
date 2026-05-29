"""
Bridge WebSocket endpoint.

Desktop daemon (the Jarvis Tauri app) opens an outbound WSS to this URL and
stays connected. The first frame is a "register" with the Supabase JWT plus
the tool catalog. We verify the JWT, slot the bridge into BridgeRegistry by
user_id, and from then on relay tool_calls between the LLM and the daemon.

URL: wss://phone-jarvis-cloud.fly.dev/bridge

The daemon authenticates with the SAME Supabase JWT it would use for any
client-side query. No separate bridge token. Token expiry is enforced by JWT
exp claim; daemon refreshes ~5 min before expiry via Supabase auth refresh.
"""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .auth import get_jwt_verifier
from .bridge import get_bridge_registry

log = logging.getLogger(__name__)
router = APIRouter(prefix="", tags=["bridge"])


@router.websocket("/bridge")
async def bridge_endpoint(websocket: WebSocket):
    """Outbound WSS from desktop daemon. Long-lived (heartbeat every 15s)."""
    await websocket.accept()
    bridge = get_bridge_registry()
    session = None

    try:
        # First frame must be 'register' with a Supabase JWT
        first = await websocket.receive_json()
        if first.get("kind") != "register":
            await websocket.close(code=4002, reason="expected register frame")
            return

        token = first.get("token")
        if not token:
            await websocket.close(code=4003, reason="missing token")
            return

        try:
            claims = await get_jwt_verifier().verify(token)
        except PermissionError as e:
            log.warning("bridge auth failed: %s", e)
            await websocket.close(code=4003, reason=f"auth_failed: {e}")
            return

        user_id = claims.get("sub")
        if not user_id:
            await websocket.close(code=4003, reason="no sub claim")
            return

        tools_schema = first.get("tools", [])
        workspace_root = first.get("workspace_root")
        daemon_version = first.get("daemon_version")
        platform = first.get("platform")

        session = await bridge.register(
            ws=websocket,
            user_id=user_id,
            tools_schema=tools_schema,
            workspace_root=workspace_root,
            daemon_version=daemon_version,
            platform=platform,
        )

        await websocket.send_text(
            json.dumps({
                "kind": "registered",
                "session_id": session.session_id,
                "server_time": int(time.time() * 1000),
            })
        )

        log.info(
            "bridge registered: user=%s session=%s tools=%d",
            user_id, session.session_id, len(tools_schema),
        )

        # Frame loop
        while True:
            try:
                frame = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            await bridge.handle_frame(session, frame)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("bridge endpoint error: %s", e)
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        if session:
            await bridge.deregister(session, reason="ws_closed")
