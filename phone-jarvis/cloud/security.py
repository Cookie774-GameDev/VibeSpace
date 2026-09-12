"""Security boundaries shared by Phone Jarvis HTTP and WebSocket handlers."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from typing import Any, Mapping
from uuid import UUID

from twilio.request_validator import RequestValidator

from .config import get_settings


_CONTROL_SEQUENCE = re.compile(r"[\x00-\x1f\x7f]|\x1b\[[0-?]*[ -/]*[@-~]")
_SECRET = re.compile(
    r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*|"
    r"((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+|"
    r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+|"
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|"
    r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})|"
    r"\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|"
    r"\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}"
)
_SENSITIVE_KEY = re.compile(
    r"(?i)^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"secret|password|credential|private[_-]?key|service[_-]?role[_-]?key)$"
)


def sanitize_context(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(value, str):
        cleaned = _CONTROL_SEQUENCE.sub("", value)[:4000]
        return _SECRET.sub(lambda match: (match.group(1) or match.group(2) or "") + "[redacted]", cleaned)
    if isinstance(value, dict):
        sanitized = {}
        for key, item in list(value.items())[:32]:
            safe_key = str(key)[:80]
            normalized_key = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", safe_key)
            sanitized[safe_key] = (
                "[redacted]"
                if _SENSITIVE_KEY.fullmatch(normalized_key)
                else sanitize_context(item, depth + 1)
            )
        return sanitized
    if isinstance(value, list):
        return [sanitize_context(item, depth + 1) for item in value[:32]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:200]


def validate_twilio_signature(
    auth_token: str,
    signature: str | None,
    url: str,
    params: Mapping[str, str],
) -> bool:
    if not auth_token or not signature or not url:
        return False
    try:
        return bool(RequestValidator(auth_token).validate(url, dict(params), signature))
    except Exception:
        return False


def canonical_request_url(path: str, query: str = "") -> str:
    base = get_settings().PHONE_JARVIS_PUBLIC_BASE_URL.rstrip("/")
    suffix = f"?{query}" if query else ""
    return f"{base}{path}{suffix}"


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class OneTimeTokenStore:
    """Bounded process-local replay cache for short-lived media tokens."""

    def __init__(self, max_entries: int = 10_000) -> None:
        self._max_entries = max_entries
        self._used: dict[str, float] = {}
        self._lock = threading.Lock()

    def consume(self, nonce: str, expires_at: float, now: float) -> bool:
        with self._lock:
            self._used = {key: exp for key, exp in self._used.items() if exp >= now}
            if nonce in self._used:
                return False
            if len(self._used) >= self._max_entries:
                oldest = min(self._used, key=self._used.get)
                self._used.pop(oldest, None)
            self._used[nonce] = expires_at
            return True


_one_time_tokens = OneTimeTokenStore()


def mint_one_time_token(
    *,
    purpose: str,
    subject: str,
    call_sid: str,
    claims: Mapping[str, Any] | None = None,
    secret: str | None = None,
    now: float | None = None,
    ttl_seconds: int = 90,
) -> str:
    signing_secret = secret or get_settings().token_secret
    if len(signing_secret.encode("utf-8")) < 32:
        raise RuntimeError("token secret is not configured")
    issued_at = int(time.time() if now is None else now)
    ttl = max(1, min(int(ttl_seconds), 300))
    payload = {
        "purpose": purpose,
        "sub": subject,
        "call_sid": call_sid,
        "nonce": secrets.token_urlsafe(18),
        "iat": issued_at,
        "exp": issued_at + ttl,
    }
    for key, value in (claims or {}).items():
        if key not in payload:
            payload[key] = value
    encoded = _encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _encode(hmac.new(signing_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def verify_one_time_token(
    token: str,
    *,
    purpose: str,
    call_sid: str,
    secret: str | None = None,
    store: OneTimeTokenStore | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    signing_secret = secret or get_settings().token_secret
    if len(signing_secret.encode("utf-8")) < 32:
        raise PermissionError("token_invalid")
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = _encode(hmac.new(
            signing_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
        ).digest())
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise PermissionError("token_invalid")
        payload = json.loads(_decode(encoded))
    except PermissionError:
        raise
    except Exception as exc:
        raise PermissionError("token_invalid") from exc

    current = time.time() if now is None else now
    if payload.get("purpose") != purpose or payload.get("call_sid") != call_sid:
        raise PermissionError("token_scope_invalid")
    if not isinstance(payload.get("exp"), (int, float)) or current > payload["exp"]:
        raise PermissionError("token_expired")
    if not isinstance(payload.get("iat"), (int, float)) or payload["iat"] > current + 30:
        raise PermissionError("token_invalid")
    try:
        UUID(str(payload.get("sub")))
    except (TypeError, ValueError) as exc:
        raise PermissionError("token_invalid") from exc
    nonce = payload.get("nonce")
    if not isinstance(nonce, str) or len(nonce) < 16:
        raise PermissionError("token_invalid")
    if not (store or _one_time_tokens).consume(nonce, float(payload["exp"]), current):
        raise PermissionError("token_replayed")
    return payload


class KillSwitchMiddleware:
    """Reject every non-health HTTP/WebSocket route until explicitly enabled."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("path") == "/health" or get_settings().PHONE_JARVIS_ENABLED:
            await self.app(scope, receive, send)
            return
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 1013, "reason": "service disabled"})
            return
        if scope.get("type") == "http":
            body = b'{"error":"service_disabled"}'
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            })
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
