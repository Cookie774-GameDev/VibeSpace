"""
LiveKit handler — the Path C entrypoint.

Two pieces:
1. POST /livekit/token  — mints a short-lived JWT for the Jarvis app to join
                          a per-user room. The app then connects via livekit-client.
2. POST /livekit/agent-join — internal hook called after the app joins. We
                              spin up a Pipecat pipeline that joins the SAME
                              room as a participant. The pipeline's audio in/out
                              flow over WebRTC to the user's app.

Free tier note (livekit.io as of 2026-05): 1000 participant-minutes/day, 50
concurrent participants. For one user making 30 min/day of in-app calls, that
is ~30 participant-minutes consumed (one user + one agent = 2 participants per
minute for typical calls), well inside the free tier. Self-host LiveKit OSS
on Oracle ARM if you outgrow it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Request
from livekit.api import AccessToken, VideoGrants
from pydantic import BaseModel

from .audit import get_audit_logger
from .auth import get_jwt_verifier, mint_call_token
from .bridge import get_bridge_registry
from .config import get_settings
from .pipeline import CallContext, ProviderKeys, build_pipeline_task
from .supabase_client import get_supabase

log = logging.getLogger(__name__)
router = APIRouter(prefix="/livekit", tags=["livekit"])


class TokenRequest(BaseModel):
    """Body of POST /livekit/token from the Jarvis app."""

    persona: str = "sage"


class TokenResponse(BaseModel):
    url: str
    token: str
    room: str
    call_id: str


@router.post("/token", response_model=TokenResponse)
async def livekit_token(
    body: TokenRequest,
    authorization: str = Header(...),
):
    """
    Mint a LiveKit join token for the user.

    The user is identified by their Supabase JWT in the Authorization header
    (Bearer <jwt>). We verify the JWT, look up the user_id, and produce a
    LiveKit access token good for 1 hour scoped to a per-user room.

    Then we spawn an asyncio task that joins the same room as the AI agent.
    The desktop app's WebRTC client will be the other participant.
    """
    s = get_settings()
    if not s.has_livekit:
        raise HTTPException(503, "LiveKit not configured")

    # Verify Supabase JWT -> resolve user_id
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    jwt_str = authorization[7:]
    try:
        claims = await get_jwt_verifier().verify(jwt_str)
    except PermissionError as e:
        raise HTTPException(401, str(e))
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "no sub claim")

    # Build LiveKit access token. Room name is per-user, so re-clicking
    # "Call Sage" while a previous call is still ringing reuses the same room.
    room_name = f"jarvis_{user_id[:16]}"
    call_id = mint_call_token()

    at = AccessToken(s.LIVEKIT_API_KEY, s.LIVEKIT_API_SECRET)
    at.with_identity(f"user_{user_id[:8]}_{int(time.time())}")
    at.with_name("Jarvis user")
    at.with_grants(
        VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
        )
    )
    at.with_ttl(3600)
    user_token = at.to_jwt()

    # Audit log: call_start (we mark transport=livekit; caller_number is None)
    persona = body.persona or "sage"
    await get_audit_logger().log_call_start(
        call_id=call_id,
        user_id=user_id,
        transport="livekit",
        caller_number=None,
        persona=persona,
    )

    # Kick off the AI agent join as a background task. The Jarvis app will see
    # the agent appear in the room within ~1s of joining.
    asyncio.create_task(_spawn_agent(room_name, user_id, call_id, persona))

    return TokenResponse(
        url=s.LIVEKIT_URL,
        token=user_token,
        room=room_name,
        call_id=call_id,
    )


async def _spawn_agent(room_name: str, user_id: str, call_id: str, persona: str) -> None:
    """Run the Pipecat pipeline as a LiveKit room participant.

    Pipecat 0.0.50+ ships a LiveKitTransport that wraps the livekit-rtc
    Python SDK. The transport owns the room connection; we just feed it into
    build_pipeline_task() exactly like the Twilio path does.
    """
    s = get_settings()
    bridge = get_bridge_registry()
    audit = get_audit_logger()

    # Per-user provider keys (BYOK) override operator defaults
    keys = await _resolve_keys_for_user(user_id)

    if not bridge.is_connected(user_id):
        log.warning("[%s] no desktop bridge connected; AI will run tool-less", call_id)

    ctx = CallContext(
        call_id=call_id,
        user_id=user_id,
        transport="livekit",
        persona=persona,
        keys=keys,
        confirmed_pin=True,  # in-app calls pre-auth via Supabase JWT, no PIN needed
    )

    try:
        # Lazy import so the cloud can boot without livekit-rtc if Path C is disabled
        from pipecat.transports.services.livekit import (
            LiveKitParams,
            LiveKitTransport,
        )

        # Mint a server-side token for the agent participant
        agent_token = (
            AccessToken(s.LIVEKIT_API_KEY, s.LIVEKIT_API_SECRET)
            .with_identity(f"sage_{call_id[:8]}")
            .with_name(persona.capitalize())
            .with_grants(
                VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .with_ttl(3600)
            .to_jwt()
        )

        transport = LiveKitTransport(
            url=s.LIVEKIT_URL,
            token=agent_token,
            room_name=room_name,
            params=LiveKitParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                vad_enabled=True,
            ),
        )

        tools_schema = bridge.get_tools_schema(user_id)
        task = build_pipeline_task(transport, ctx, bridge, tools_schema)

        from pipecat.pipeline.runner import PipelineRunner

        runner = PipelineRunner()
        await runner.run(task)

    except Exception as e:
        log.exception("[%s] agent run failed: %s", call_id, e)
        await audit.log_call_end(call_id, end_reason="error", cost_estimate_usd=0.0)
    else:
        await audit.log_call_end(call_id, end_reason="user_hangup", cost_estimate_usd=0.0)


async def _resolve_keys_for_user(user_id: str) -> ProviderKeys:
    """Look up per-user BYOK from Supabase, fall back to operator defaults."""
    s = get_settings()
    keys = ProviderKeys(
        deepgram=s.DEEPGRAM_API_KEY or None,
        anthropic=s.ANTHROPIC_API_KEY or None,
        cartesia=s.CARTESIA_API_KEY or None,
        groq=s.GROQ_API_KEY or None,
    )
    if not s.has_supabase:
        return keys
    try:
        sb = get_supabase()
        resp = (
            sb.table("phone_settings")
            .select("byok_provider_keys")
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        byok = (resp.data or {}).get("byok_provider_keys") or {}
        # User keys override operator defaults
        keys.deepgram = byok.get("deepgram") or keys.deepgram
        keys.anthropic = byok.get("anthropic") or keys.anthropic
        keys.cartesia = byok.get("cartesia") or keys.cartesia
        keys.groq = byok.get("groq") or keys.groq
    except Exception as e:
        log.warning("BYOK lookup failed for %s: %s; using operator defaults", user_id, e)
    return keys
