"""
Outbound calling — Jarvis dials the user.

Triggered by:
- Manual: user says "Sage, call me at 3pm" via the Assistant (Mod+J)
- Error-driven: a Jarvis runtime event posts to /outbound/event with
  category="error" and the user has error_calls=true in their settings
- Schedule: a daily cron evaluates phone_settings.scheduled_outbound

POST /outbound/call body:
  {
    "user_id": "uuid",      # whose number to call
    "reason": "build_failed",
    "context": {            # passed to the LLM as system prompt prefix
      "title": "Build failed",
      "details": "TypeScript error in App.tsx line 42..."
    }
  }

Returns: { call_sid: "CA...", status: "queued" }

Twilio dials the user. When they answer, Twilio hits /twiml-outbound which
returns TwiML connecting them to the same Media Stream / Pipecat flow as
inbound, but with `outbound_context` injected into the persona prompt so
Sage greets with the reason instead of "what's up?"
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Form, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from twilio.rest import Client as TwilioClient
from twilio.twiml.voice_response import Connect, Stream, VoiceResponse

from .auth import get_jwt_verifier
from .config import get_settings
from .supabase_client import get_supabase

log = logging.getLogger(__name__)
router = APIRouter(prefix="/outbound", tags=["outbound"])


class CallRequest(BaseModel):
    reason: str  # e.g. "build_failed", "manual", "scheduled", "todo_due"
    context: dict = {}


class CallResponse(BaseModel):
    call_sid: str
    status: str


class MessageRequest(BaseModel):
    reason: str = "manual"
    message: str
    context: dict = {}


class MessageResponse(BaseModel):
    message_sid: str
    status: str


@router.post("/call", response_model=CallResponse)
async def outbound_call(
    body: CallRequest,
    request: Request,
    authorization: str = Header(...),
):
    """Mint a Twilio outbound call to the authenticated user's stored number."""
    s = get_settings()
    if not s.has_twilio:
        raise HTTPException(503, "Twilio not configured")

    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    try:
        claims = await get_jwt_verifier().verify(authorization[7:])
    except PermissionError as e:
        raise HTTPException(401, str(e))
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "no sub claim")

    # Look up user's stored phone number + outbound preferences
    settings_row = await _phone_settings(user_id)
    if not settings_row:
        raise HTTPException(404, "phone_settings not configured for this user")

    user_number = settings_row.get("user_phone_number")
    if not user_number:
        raise HTTPException(400, "user has not stored a phone number")

    # Per-category opt-in check (default OFF for everything except 'manual')
    triggers = settings_row.get("outbound_triggers", {}) or {}
    category = body.reason or "manual"
    cat_enabled = triggers.get(category, category == "manual")
    if not cat_enabled:
        raise HTTPException(403, f"outbound trigger '{category}' is disabled in settings")

    # Stash the outbound context in a short-lived row keyed by call_sid; the
    # /twiml-outbound endpoint reads it back when Twilio's side connects.
    sb = get_supabase()
    twiml_url = f"{request.url.scheme}://{request.url.netloc}/outbound/twiml"

    twilio = TwilioClient(s.TWILIO_ACCOUNT_SID, s.TWILIO_AUTH_TOKEN)
    call = twilio.calls.create(
        to=user_number,
        from_=s.TWILIO_PHONE_NUMBER,
        url=twiml_url,
        method="POST",
        # Ringer time
        timeout=30,
    )
    call_sid = call.sid

    # Stash outbound context for the TwiML callback to read
    try:
        sb.table("outbound_pending").insert({
            "call_sid": call_sid,
            "user_id": user_id,
            "reason": body.reason,
            "context": body.context,
        }).execute()
    except Exception as e:
        log.warning("could not stash outbound context: %s", e)

    return CallResponse(call_sid=call_sid, status="queued")


@router.post("/message", response_model=MessageResponse)
async def outbound_message(
    body: MessageRequest,
    authorization: str = Header(...),
):
    """Send an SMS to the authenticated user's stored phone number."""
    s = get_settings()
    if not s.has_twilio:
        raise HTTPException(503, "Twilio not configured")

    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    try:
        claims = await get_jwt_verifier().verify(authorization[7:])
    except PermissionError as e:
        raise HTTPException(401, str(e))
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "no sub claim")

    settings_row = await _phone_settings(user_id)
    if not settings_row:
        raise HTTPException(404, "phone_settings not configured for this user")

    user_number = settings_row.get("user_phone_number")
    if not user_number:
        raise HTTPException(400, "user has not stored a phone number")

    triggers = settings_row.get("outbound_triggers", {}) or {}
    category = body.reason or "manual"
    cat_enabled = triggers.get(category, category == "manual")
    if not cat_enabled:
        raise HTTPException(403, f"outbound trigger '{category}' is disabled in settings")

    text = body.message.strip()
    if not text:
        raise HTTPException(400, "message is empty")
    if len(text) > 1200:
        text = text[:1197] + "..."

    twilio = TwilioClient(s.TWILIO_ACCOUNT_SID, s.TWILIO_AUTH_TOKEN)
    msg = twilio.messages.create(
        to=user_number,
        from_=s.TWILIO_PHONE_NUMBER,
        body=text,
    )
    return MessageResponse(message_sid=msg.sid, status=msg.status or "queued")


@router.post("/twiml")
async def outbound_twiml(
    request: Request,
    CallSid: str = Form(...),
    From: str = Form(...),
    To: str = Form(...),
):
    """
    Twilio fires this when the user picks up. We return TwiML connecting them
    to a Media Stream like the inbound path, but with `outbound_context`
    injected as a custom parameter.
    """
    sb = get_supabase()
    user_id = "unknown"
    reason = "manual"
    context: dict = {}

    try:
        resp = (
            sb.table("outbound_pending")
            .select("*")
            .eq("call_sid", CallSid)
            .single()
            .execute()
        )
        row = resp.data or {}
        user_id = row.get("user_id", "unknown")
        reason = row.get("reason", "manual")
        context = row.get("context", {}) or {}
    except Exception as e:
        log.warning("[%s] outbound context lookup failed: %s", CallSid, e)

    host = request.headers.get("host", "")
    ws_url = f"wss://{host}/twilio/{CallSid}"

    vr = VoiceResponse()
    connect = Connect()
    stream = Stream(url=ws_url)
    stream.parameter(name="user_id", value=user_id)
    stream.parameter(name="from_number", value=To)  # the user's own number
    stream.parameter(name="caller_preauth", value="true")
    stream.parameter(name="outbound_reason", value=reason)
    stream.parameter(name="outbound_context", value=json.dumps(context))
    connect.append(stream)
    vr.append(connect)
    return Response(content=str(vr), media_type="application/xml")


async def _phone_settings(user_id: str) -> Optional[dict]:
    s = get_settings()
    if not s.has_supabase:
        return None
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
        log.warning("phone_settings lookup failed: %s", e)
        return None
