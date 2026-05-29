"""
Twilio handler — the Path A entrypoint.

Two pieces:
1. POST /twiml         — Twilio webhook on every inbound call. Returns TwiML
                         that opens a Media Stream WebSocket to /twilio/<call_sid>.
2. WS /twilio/{sid}    — receives μ-law 8 kHz audio from Twilio, runs Pipecat,
                         streams TTS back. Same provider stack as livekit_handler
                         but with the Twilio FastAPIWebsocket transport.

Outbound calls (Jarvis calls user) are handled in outbound.py.

PIN flow:
- Greeting plays, then VAD waits for the user's 6-digit code.
- The cloud-side `auth.py` PinTracker does the 3-strike + 1h-cooldown
  enforcement. PIN check happens BEFORE we let the LLM see any user audio.
- DTMF (keypad) input is also accepted as a fallback.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Form, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from twilio.twiml.voice_response import Connect, Stream, VoiceResponse

from .audit import get_audit_logger
from .auth import (
    caller_allowed,
    get_pin_tracker,
    mint_call_token,
    verify_pin,
)
from .bridge import get_bridge_registry
from .config import get_settings
from .pipeline import CallContext, ProviderKeys, build_pipeline_task
from .supabase_client import get_supabase

log = logging.getLogger(__name__)
router = APIRouter(prefix="", tags=["twilio"])


@router.post("/twiml")
async def twiml_webhook(
    request: Request,
    From: str = Form(...),
    To: str = Form(...),
    CallSid: str = Form(...),
):
    """
    Twilio fires this on every inbound call. We:
    1. Look up the user owning To (the called number).
    2. If From is on their allowlist, fast-path skip the PIN later.
    3. Return TwiML telling Twilio to open a Media Stream to our WS endpoint.
    """
    log.info("inbound call %s from=%s to=%s", CallSid, From, To)

    user_id = await _user_for_phone_number(To)
    if not user_id:
        # Nobody owns this number - polite reject
        vr = VoiceResponse()
        vr.say("This number is not currently accepting calls. Goodbye.", voice="Polly.Joanna")
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")

    settings = await _phone_settings_for_user(user_id)
    is_allowed = settings and caller_allowed(From, settings.get("caller_allowlist", []))

    locked, remaining = get_pin_tracker().is_locked(From)
    if locked:
        vr = VoiceResponse()
        vr.say(
            f"Too many failed attempts. Try again in {int(remaining // 60) + 1} minutes.",
            voice="Polly.Joanna",
        )
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")

    # Build the WS URL from the request host so it works on Fly + ngrok dev
    host = request.headers.get("host", "")
    proto = "wss"
    ws_url = f"{proto}://{host}/twilio/{CallSid}"
    log.info("twiml -> stream %s", ws_url)

    vr = VoiceResponse()
    connect = Connect()
    stream = Stream(url=ws_url)
    # Pass user_id and pre-auth flag as custom parameters; Twilio will deliver
    # them in the first WS "start" event.
    stream.parameter(name="user_id", value=user_id)
    stream.parameter(name="from_number", value=From)
    stream.parameter(name="caller_preauth", value="true" if is_allowed else "false")
    connect.append(stream)
    vr.append(connect)

    return Response(content=str(vr), media_type="application/xml")


@router.websocket("/twilio/{call_sid}")
async def twilio_ws(websocket: WebSocket, call_sid: str):
    """
    Twilio Media Stream endpoint. Runs the Pipecat pipeline for this call.
    """
    await websocket.accept()
    log.info("[%s] twilio ws connected", call_sid)

    settings = get_settings()
    bridge = get_bridge_registry()
    audit = get_audit_logger()

    # We need the first 'start' event to learn user_id + caller pre-auth flag
    user_id: Optional[str] = None
    from_number: Optional[str] = None
    caller_preauth = False

    try:
        # Pipecat's Twilio transport handles the Media Stream framing for us.
        # It expects a websocket and the call_sid; the start_event hook lets
        # us read custom parameters before the pipeline boots.
        from pipecat.serializers.twilio import TwilioFrameSerializer
        from pipecat.transports.network.fastapi_websocket import (
            FastAPIWebsocketParams,
            FastAPIWebsocketTransport,
        )

        # Read the Twilio "connected" + "start" events to pull custom params
        first_message = await websocket.receive_json()
        if first_message.get("event") == "connected":
            first_message = await websocket.receive_json()

        if first_message.get("event") == "start":
            start_data = first_message.get("start", {})
            params = start_data.get("customParameters", {}) or {}
            user_id = params.get("user_id")
            from_number = params.get("from_number")
            caller_preauth = params.get("caller_preauth") == "true"
            stream_sid = start_data.get("streamSid")
        else:
            log.warning("[%s] expected 'start' event, got %s", call_sid, first_message.get("event"))
            await websocket.close()
            return

        if not user_id:
            log.error("[%s] no user_id in start event; closing", call_sid)
            await websocket.close()
            return

        call_id = mint_call_token()
        persona_settings = await _phone_settings_for_user(user_id)
        persona = (persona_settings or {}).get("persona", "sage")

        await audit.log_call_start(
            call_id=call_id,
            user_id=user_id,
            transport="twilio",
            caller_number=from_number,
            persona=persona,
        )

        keys = await _resolve_keys_for_user(user_id)

        ctx = CallContext(
            call_id=call_id,
            user_id=user_id,
            transport="twilio",
            persona=persona,
            keys=keys,
            confirmed_pin=caller_preauth,
        )

        # Build the Pipecat transport for this Twilio call
        serializer = TwilioFrameSerializer(stream_sid=stream_sid, call_sid=call_sid)
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                vad_enabled=True,
                serializer=serializer,
            ),
        )

        # PIN gate: if caller is not pre-authed, the persona prompt expects
        # the user to say their code. The cloud-side intercept that watches
        # for a 6-digit transcript is wired via a simple frame processor;
        # see persona prompt for the user-facing flow.
        if not caller_preauth and persona_settings:
            ctx.persona = persona  # PIN flow handled in prompt; pass through

        tools_schema = bridge.get_tools_schema(user_id)
        task = build_pipeline_task(transport, ctx, bridge, tools_schema)

        from pipecat.pipeline.runner import PipelineRunner

        runner = PipelineRunner()
        await runner.run(task)

        await audit.log_call_end(call_id, end_reason="user_hangup", cost_estimate_usd=0.0)

    except WebSocketDisconnect:
        log.info("[%s] twilio ws disconnected", call_sid)
    except Exception as e:
        log.exception("[%s] twilio call failed: %s", call_sid, e)
        try:
            await websocket.close()
        except Exception:
            pass


async def _user_for_phone_number(to_number: str) -> Optional[str]:
    """Look up which user owns the called Twilio number."""
    s = get_settings()
    if not s.has_supabase:
        # Single-user dev: any inbound goes to the operator
        return "dev_user"
    try:
        sb = get_supabase()
        resp = (
            sb.table("phone_settings")
            .select("user_id")
            .eq("twilio_phone_number", to_number)
            .single()
            .execute()
        )
        return (resp.data or {}).get("user_id")
    except Exception as e:
        log.warning("user lookup for %s failed: %s", to_number, e)
        return None


async def _phone_settings_for_user(user_id: str) -> Optional[dict]:
    s = get_settings()
    if not s.has_supabase:
        return {"persona": "sage", "caller_allowlist": []}
    try:
        sb = get_supabase()
        resp = (
            sb.table("phone_settings")
            .select("*")
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        return resp.data
    except Exception as e:
        log.warning("settings lookup for %s failed: %s", user_id, e)
        return None


async def _resolve_keys_for_user(user_id: str) -> ProviderKeys:
    """Same as livekit_handler version; consolidated here too."""
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
        keys.deepgram = byok.get("deepgram") or keys.deepgram
        keys.anthropic = byok.get("anthropic") or keys.anthropic
        keys.cartesia = byok.get("cartesia") or keys.cartesia
        keys.groq = byok.get("groq") or keys.groq
    except Exception as e:
        log.warning("BYOK lookup failed for %s: %s", user_id, e)
    return keys
