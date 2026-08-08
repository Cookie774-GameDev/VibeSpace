"""Long-running Telnyx media gateway for approved third-party calls.

The gateway owns the real-time audio loop. Supabase Edge Functions only
prepare/approve/start calls and accept bounded provider callbacks.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .config import Settings, get_settings

router = APIRouter(tags=["telnyx"])

PROTECTED_MARKERS = (
    "payment",
    "card number",
    "bank account",
    "deposit",
    "cancellation fee",
    "paid order",
    "contract",
    "legal agreement",
    "authentication code",
    "password reset",
    "prescription",
)


def build_opening_disclosure(display_name: str, purpose: str) -> str:
    safe_name = "the person I am assisting" if not display_name.strip() else display_name.strip()
    safe_purpose = purpose.strip().rstrip(".")
    return (
        f"Hello, I’m the VibeSPACE AI assistant calling on behalf of {safe_name}. "
        f"I’m calling to {safe_purpose}."
    )


def requires_live_approval(text: str) -> bool:
    normalized = text.casefold()
    return any(marker in normalized for marker in PROTECTED_MARKERS)


def recipient_requested_termination(text: str) -> bool:
    normalized = f" {text.casefold().strip()} "
    return any(
        phrase in normalized
        for phrase in (" goodbye", " hang up", " end the call", " stop calling")
    )


def recipient_requested_opt_out(text: str) -> bool:
    normalized = text.casefold()
    return any(
        phrase in normalized
        for phrase in (
            "do not call",
            "don't call",
            "stop calling",
            "remove me from your call",
        )
    )


@dataclass(frozen=True)
class ProviderUsage:
    telnyx_transport_usd: float = 0
    deepgram_stt_usd: float = 0
    deepgram_tts_usd: float = 0
    deepseek_usd: float = 0

    @property
    def total_usd(self) -> float:
        return sum(
            max(0.0, value)
            for value in (
                self.telnyx_transport_usd,
                self.deepgram_stt_usd,
                self.deepgram_tts_usd,
                self.deepseek_usd,
            )
        )


def credits_for_usage(usage: ProviderUsage, reserved_credits: int) -> int:
    return min(max(0, reserved_credits), max(0, math.ceil(usage.total_usd * 1000)))


@dataclass
class TelnyxMediaSession:
    job_id: str
    maximum_duration_seconds: int
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    awaiting_live_approval: str | None = None
    ended: bool = False

    def expired(self, now: datetime | None = None) -> bool:
        current = now or datetime.now(UTC)
        return (current - self.started_at).total_seconds() >= self.maximum_duration_seconds

    def request_live_approval(self, reason: str) -> bool:
        if self.awaiting_live_approval is not None:
            return False
        self.awaiting_live_approval = reason[:120]
        return True

    def resolve_live_approval(self, approved: bool) -> None:
        _ = approved
        self.awaiting_live_approval = None


class CallPipeline:
    """One-call Deepgram Flux -> DeepSeek -> Aura streaming pipeline."""

    def __init__(self, websocket: WebSocket, job: dict[str, Any], settings: Settings) -> None:
        self.websocket = websocket
        self.job = job
        self.settings = settings
        self.session = TelnyxMediaSession(
            job_id=str(job["id"]),
            maximum_duration_seconds=int(job["maximum_duration_seconds"]),
        )
        self.telnyx_stream_id: str | None = None
        self.audio_bytes = 0
        self.tts_characters = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.transcript: list[dict[str, str]] = []
        self._deepgram: Any = None
        self._last_media_at = datetime.now(UTC)
        self._silence_prompted = False

    async def run(self, start_message: dict[str, Any]) -> None:
        self.telnyx_stream_id = str(start_message.get("stream_id") or "")
        dg_url = (
            "wss://api.deepgram.com/v1/listen"
            f"?model={self.settings.DEEPGRAM_FLUX_MODEL}"
            "&encoding=mulaw&sample_rate=8000&channels=1"
            "&interim_results=true&vad_events=true"
        )
        async with websockets.connect(
            dg_url,
            additional_headers={"Authorization": f"Token {self.settings.DEEPGRAM_API_KEY}"},
            max_size=2**20,
            ping_interval=20,
        ) as deepgram:
            self._deepgram = deepgram
            await self._speak(str(self.job["opening_disclosure"]))
            consumer = asyncio.create_task(self._consume_transcripts())
            try:
                while not self.session.ended and not self.session.expired():
                    try:
                        packet = await asyncio.wait_for(
                            self.websocket.receive_json(), timeout=5
                        )
                    except asyncio.TimeoutError:
                        idle = (datetime.now(UTC) - self._last_media_at).total_seconds()
                        if idle >= self.settings.IDLE_HANGUP_SECONDS * 2:
                            self.session.ended = True
                            break
                        if (
                            idle >= self.settings.IDLE_HANGUP_SECONDS
                            and not self._silence_prompted
                        ):
                            self._silence_prompted = True
                            await self._speak(
                                "Are you still there? I can end the call if now is not a good time."
                            )
                        continue
                    event = packet.get("event")
                    if event == "media":
                        encoded = packet.get("media", {}).get("payload", "")
                        try:
                            audio = base64.b64decode(encoded, validate=True)
                        except (ValueError, TypeError):
                            continue
                        if len(audio) > 64_000:
                            continue
                        self.audio_bytes += len(audio)
                        self._last_media_at = datetime.now(UTC)
                        self._silence_prompted = False
                        await deepgram.send(audio)
                    elif event == "stop":
                        break
            finally:
                self.session.ended = True
                await deepgram.send(json.dumps({"type": "CloseStream"}))
                consumer.cancel()
                await asyncio.gather(consumer, return_exceptions=True)

    async def _consume_transcripts(self) -> None:
        async for raw in self._deepgram:
            try:
                event = json.loads(raw)
                alt = event.get("channel", {}).get("alternatives", [{}])[0]
                transcript = str(alt.get("transcript") or "").strip()
                is_final = event.get("is_final") is True
            except (ValueError, TypeError, IndexError):
                continue
            if not transcript or not is_final or self.session.awaiting_live_approval:
                continue
            self.transcript.append({"role": "recipient", "content": transcript[:2000]})
            if recipient_requested_opt_out(transcript):
                await self._record_recipient_opt_out()
                await self._speak(
                    "Understood. This number has been added to the do-not-call list. Goodbye."
                )
                self.session.ended = True
                continue
            if recipient_requested_termination(transcript):
                await self._speak("Understood. Thank you for your time. Goodbye.")
                self.session.ended = True
                continue
            await self.websocket.send_json(
                {"event": "clear", "stream_id": self.telnyx_stream_id}
            )
            reply = await self._respond(transcript)
            if requires_live_approval(reply):
                self.session.request_live_approval("protected_action")
                await self._speak(
                    "One moment while I confirm that with the person I’m assisting."
                )
                await self._mark_awaiting_approval(reply)
                decision = await self._wait_for_live_approval()
                self.session.resolve_live_approval(decision == "approved")
                if decision == "approved":
                    await self._speak(
                        "The person I’m assisting approved that request. "
                        "I still cannot provide payment credentials or authentication codes."
                    )
                elif decision == "declined":
                    await self._speak(
                        "The person I’m assisting declined that request. "
                        "Let’s continue without it."
                    )
                else:
                    self.session.ended = True
                continue
            await self._speak(reply)

    async def _respond(self, recipient_text: str) -> str:
        system = (
            "You are the VibeSPACE AI assistant on a third-party call. "
            "Always identify as AI. Stay strictly within the approved purpose and script. "
            "Never make payments, purchases, contracts, legal commitments, account recovery, "
            "authentication-code exchanges, emergency calls, or disclose sensitive data. "
            "If a protected commitment is requested, say you need live approval. "
            f"Approved purpose: {self.job['purpose']}. "
            f"Approved script: {self.job['approved_script']}."
        )
        messages = [{"role": "system", "content": system}, *self.transcript[-12:]]
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.deepseek.com/chat/completions",
                headers={"Authorization": f"Bearer {self.settings.DEEPSEEK_API_KEY}"},
                json={
                    "model": self.settings.DEEPSEEK_MODEL,
                    "messages": messages,
                    "max_tokens": 220,
                    "temperature": 0.2,
                },
            )
            response.raise_for_status()
            data = response.json()
        usage = data.get("usage", {})
        self.input_tokens += int(usage.get("prompt_tokens") or 0)
        self.output_tokens += int(usage.get("completion_tokens") or 0)
        reply = str(data["choices"][0]["message"]["content"]).strip()[:1200]
        self.transcript.append({"role": "assistant", "content": reply})
        return reply

    async def _speak(self, text: str) -> None:
        self.tts_characters += len(text)
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.deepgram.com/v1/speak",
                params={
                    "model": self.settings.DEEPGRAM_AURA_MODEL,
                    "encoding": "mulaw",
                    "container": "none",
                    "sample_rate": "8000",
                },
                headers={
                    "Authorization": f"Token {self.settings.DEEPGRAM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={"text": text},
            )
            response.raise_for_status()
            audio = response.content
        for offset in range(0, len(audio), 4_000):
            await self.websocket.send_json(
                {
                    "event": "media",
                    "stream_id": self.telnyx_stream_id,
                    "media": {
                        "payload": base64.b64encode(audio[offset : offset + 4_000]).decode()
                    },
                }
            )

    async def _mark_awaiting_approval(self, summary: str) -> None:
        await _supabase_update(
            self.settings,
            "outbound_call_jobs",
            self.job["id"],
            {
                "status": "awaiting_live_approval",
                "provider_status": "awaiting_live_approval",
                "result_summary": summary[:1000],
                "pending_action_summary": summary[:1000],
                "pending_action_requested_at": datetime.now(UTC).isoformat(),
                "pending_action_decision": None,
                "pending_action_decided_at": None,
            },
        )

    async def _record_recipient_opt_out(self) -> None:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{self.settings.SUPABASE_URL}/rest/v1/rpc/record_recipient_call_opt_out",
                headers=await _supabase_headers(self.settings),
                json={"p_job_id": self.job["id"], "p_source": "recipient_request"},
            )
            response.raise_for_status()

    async def _wait_for_live_approval(self) -> str | None:
        while not self.session.expired() and not self.session.ended:
            await asyncio.sleep(2)
            state = await _job_by_id(self.settings, str(self.job["id"]))
            if not state or state.get("status") in {"cancelled", "failed", "blocked"}:
                return None
            decision = state.get("pending_action_decision")
            if decision in {"approved", "declined"}:
                return str(decision)
        return None

    def provider_usage(self) -> ProviderUsage:
        duration_minutes = min(
            self.session.maximum_duration_seconds,
            max(0, (datetime.now(UTC) - self.session.started_at).total_seconds()),
        ) / 60
        return ProviderUsage(
            telnyx_transport_usd=duration_minutes
            * self.settings.TELNYX_VOICE_USD_PER_MINUTE,
            deepgram_stt_usd=(self.audio_bytes / 8_000 / 60)
            * self.settings.DEEPGRAM_FLUX_USD_PER_MINUTE,
            deepgram_tts_usd=(self.tts_characters / 1_000_000)
            * self.settings.DEEPGRAM_AURA_USD_PER_MILLION_CHARS,
            deepseek_usd=(self.input_tokens / 1_000_000)
            * self.settings.DEEPSEEK_INPUT_USD_PER_MILLION_TOKENS
            + (self.output_tokens / 1_000_000)
            * self.settings.DEEPSEEK_OUTPUT_USD_PER_MILLION_TOKENS,
        )


async def _supabase_headers(settings: Settings) -> dict[str, str]:
    return {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


async def _supabase_update(
    settings: Settings, table: str, row_id: str, values: dict[str, Any]
) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.patch(
            f"{settings.SUPABASE_URL}/rest/v1/{table}",
            params={"id": f"eq.{row_id}"},
            headers={**await _supabase_headers(settings), "Prefer": "return=minimal"},
            json=values,
        )
        response.raise_for_status()


async def _job_for_call(settings: Settings, call_control_id: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/outbound_call_jobs",
            params={
                "provider_call_id": f"eq.{call_control_id}",
                "select": "*",
                "limit": "1",
            },
            headers=await _supabase_headers(settings),
        )
        response.raise_for_status()
        rows = response.json()
    return rows[0] if rows else None


async def _job_by_id(settings: Settings, job_id: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            f"{settings.SUPABASE_URL}/rest/v1/outbound_call_jobs",
            params={"id": f"eq.{job_id}", "select": "*", "limit": "1"},
            headers=await _supabase_headers(settings),
        )
        response.raise_for_status()
        rows = response.json()
    return rows[0] if rows else None


async def _settle(
    settings: Settings,
    job: dict[str, Any],
    pipeline: CallPipeline,
    status: str,
    failure_reason: str | None,
) -> None:
    elapsed = max(0, int((datetime.now(UTC) - pipeline.session.started_at).total_seconds()))
    actual = credits_for_usage(
        pipeline.provider_usage(), int(job.get("reserved_credits") or 0)
    )
    summary = None
    if pipeline.transcript:
        summary = pipeline.transcript[-1]["content"][:4000]
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{settings.SUPABASE_URL}/rest/v1/rpc/complete_outbound_call_job",
            headers=await _supabase_headers(settings),
            json={
                "p_job_id": job["id"],
                "p_status": status,
                "p_actual_credits": actual,
                "p_duration_seconds": elapsed,
                "p_provider_call_id": job.get("provider_call_id"),
                "p_provider_status": status,
                "p_result_summary": summary,
                "p_failure_reason": failure_reason,
            },
        )
        response.raise_for_status()


@router.websocket("/telnyx/media")
async def telnyx_media(websocket: WebSocket) -> None:
    settings = get_settings()
    if not settings.has_call_anyone_pipeline:
        await websocket.close(code=1013, reason="calling_unconfigured")
        return
    await websocket.accept()
    pipeline: CallPipeline | None = None
    job: dict[str, Any] | None = None
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if first.get("event") != "start":
            await websocket.close(code=1008, reason="start_required")
            return
        start = first.get("start", {})
        call_control_id = str(start.get("call_control_id") or "")
        if not call_control_id or len(call_control_id) > 160:
            await websocket.close(code=1008, reason="invalid_call")
            return
        job = await _job_for_call(settings, call_control_id)
        if not job or job.get("status") not in {
            "queued",
            "dialing",
            "ringing",
            "in_progress",
        }:
            await websocket.close(code=1008, reason="unapproved_call")
            return
        pipeline = CallPipeline(websocket, job, settings)
        await pipeline.run(start)
        await _settle(settings, job, pipeline, "completed", None)
    except (WebSocketDisconnect, asyncio.TimeoutError):
        if pipeline and job:
            await _settle(settings, job, pipeline, "failed", "media_disconnected")
    except Exception:
        if pipeline and job:
            await _settle(settings, job, pipeline, "failed", "media_gateway_error")
        try:
            await websocket.close(code=1011, reason="media_gateway_error")
        except RuntimeError:
            pass
