"""
phone-jarvis cloud — FastAPI entrypoint.

Mounts:
  POST /twiml                  - Twilio inbound webhook (Path A)
  WS   /twilio/{call_sid}      - Twilio Media Stream (Path A)
  POST /outbound/call          - Jarvis dials user (Path A outbound)
  POST /outbound/twiml         - TwiML callback when user answers
  POST /livekit/token          - mint room token + spawn agent (Path C)
  WS   /bridge                 - desktop daemon registers + receives tool_calls
  GET  /health                 - liveness probe
  GET  /admin/metrics          - latency / cost histograms (token-gated)

Runs in one Python process. Pipecat manages per-call concurrency. Bridge
registry is process-global (one machine = one user-bridge map). For multi-
machine deploys, swap BridgeRegistry for a Redis-backed implementation;
the rest of the codebase doesn't care.
"""

from __future__ import annotations

import asyncio
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .audit import get_audit_logger
from .bridge_endpoint import router as bridge_router
from .config import get_settings
from .livekit_handler import router as livekit_router
from .outbound import router as outbound_router
from .twilio_handler import router as twilio_router

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("phone-jarvis.cloud")

app = FastAPI(
    title="phone-jarvis cloud",
    version="0.1.0",
    description="Voice loop + tool dispatcher for the Jarvis app.",
)

# CORS: the Jarvis app calls /livekit/token from within the WebView. Allow
# tauri:// and http://localhost. Production uses HTTPS only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://localhost:5173",
        "http://tauri.localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(twilio_router)
app.include_router(livekit_router)
app.include_router(outbound_router)
app.include_router(bridge_router)


@app.get("/health")
async def health():
    s = get_settings()
    return {
        "ok": True,
        "version": "0.1.0",
        "transports": {
            "twilio": s.has_twilio,
            "livekit": s.has_livekit,
            "supabase": s.has_supabase,
        },
    }


@app.get("/admin/metrics")
async def admin_metrics():
    """Stub. In production, wire to Prometheus / OpenTelemetry."""
    return {"todo": "implement after first calls land"}


@app.on_event("startup")
async def startup():
    s = get_settings()
    log.info(
        "phone-jarvis cloud starting | twilio=%s livekit=%s supabase=%s",
        s.has_twilio, s.has_livekit, s.has_supabase,
    )
    # Daily prune of audit logs older than retention window
    asyncio.create_task(_audit_prune_loop())


async def _audit_prune_loop():
    audit = get_audit_logger()
    while True:
        try:
            removed = await audit.prune_old()
            if removed:
                log.info("pruned %d old audit entries", removed)
        except Exception as e:
            log.warning("audit prune failed: %s", e)
        await asyncio.sleep(86400)  # 24h


@app.on_event("shutdown")
async def shutdown():
    log.info("phone-jarvis cloud shutting down")
