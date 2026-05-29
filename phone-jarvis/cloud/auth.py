"""
Authentication primitives.

Three doors:
1. Caller phone-number allowlist (Path A only) - filters before agent spin-up.
2. Spoken PIN at call start (6 digits, 3-strike, 1h cooldown after lockout).
3. Per-call session token (correlates cloud and bridge audit).

Bridge auth (separate): the desktop daemon dials in with a JWT minted by
Supabase. We verify the JWT against Supabase's JWKS endpoint - no shared
secret, no per-user pepper, just standard JWT.

PIN storage: hashed (PBKDF2-SHA256, 100k iters) in Supabase
`phone_settings.pin_hash`. Never plaintext.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx
from jose import jwt, JWTError

from .config import get_settings

log = logging.getLogger(__name__)

PIN_ITERATIONS = 100_000
PIN_HASH_LEN = 32


# ============================================================================
# PIN: 6-digit code, hashed at rest, constant-time compare
# ============================================================================


def hash_pin(pin: str, salt: bytes) -> bytes:
    """PBKDF2-SHA256 of a numeric PIN. Salt is per-user, stored alongside hash."""
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PIN_ITERATIONS, dklen=PIN_HASH_LEN)


def make_pin_record(pin: str) -> dict:
    """Hash a fresh PIN for storage in Supabase. Caller writes to phone_settings."""
    if not pin.isdigit() or not 4 <= len(pin) <= 8:
        raise ValueError("PIN must be 4-8 digits")
    salt = secrets.token_bytes(16)
    h = hash_pin(pin, salt)
    return {
        "pin_salt": salt.hex(),
        "pin_hash": h.hex(),
        "pin_length": len(pin),
    }


def verify_pin(pin: str, record: dict) -> bool:
    """Constant-time compare of a candidate PIN against a stored hash."""
    if not pin or not pin.isdigit():
        return False
    try:
        salt = bytes.fromhex(record.get("pin_salt", ""))
        expected = bytes.fromhex(record.get("pin_hash", ""))
    except ValueError:
        return False
    if not salt or not expected:
        return False
    candidate = hash_pin(pin, salt)
    return hmac.compare_digest(candidate, expected)


# ============================================================================
# PIN attempt tracking — in-memory, per phone number, with cooldown
# ============================================================================


@dataclass
class PinAttemptState:
    failed: int = 0
    locked_until: float = 0.0


class PinTracker:
    """In-memory PIN attempt tracker with 3-strike + 1h cooldown."""

    def __init__(self) -> None:
        self._state: dict[str, PinAttemptState] = {}

    def is_locked(self, caller_number: str) -> tuple[bool, float]:
        st = self._state.get(caller_number)
        if not st:
            return False, 0.0
        now = time.time()
        if st.locked_until > now:
            return True, st.locked_until - now
        return False, 0.0

    def record_failure(self, caller_number: str) -> int:
        s = get_settings()
        st = self._state.setdefault(caller_number, PinAttemptState())
        st.failed += 1
        if st.failed >= s.PIN_MAX_ATTEMPTS:
            st.locked_until = time.time() + s.PIN_COOLDOWN_SECONDS
        return st.failed

    def record_success(self, caller_number: str) -> None:
        self._state.pop(caller_number, None)


_pin_tracker: Optional[PinTracker] = None


def get_pin_tracker() -> PinTracker:
    global _pin_tracker
    if _pin_tracker is None:
        _pin_tracker = PinTracker()
    return _pin_tracker


# ============================================================================
# Caller-ID allowlist (Path A) — pre-auth shortcut
# ============================================================================


def caller_allowed(caller_number: str, allowlist: list[str]) -> bool:
    """Match E.164 numbers, normalizing common formats."""
    norm = _normalize(caller_number)
    for entry in allowlist:
        if _normalize(entry) == norm:
            return True
    return False


def _normalize(num: str) -> str:
    """Strip non-digits, drop a leading 1 for US numbers, prepend +."""
    digits = "".join(c for c in num if c.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return f"+1{digits}" if len(digits) == 10 else f"+{digits}"


# ============================================================================
# Supabase JWT verification (bridge auth)
# ============================================================================


@dataclass
class JwtVerifier:
    """Verifies Supabase Auth JWTs against the project JWKS."""

    jwks_url: str
    audience: str = "authenticated"
    _jwks_cache: Optional[dict] = field(default=None, init=False)
    _jwks_cache_ts: float = field(default=0.0, init=False)
    _jwks_ttl: float = field(default=3600.0, init=False)

    async def _fetch_jwks(self) -> dict:
        now = time.time()
        if self._jwks_cache and (now - self._jwks_cache_ts) < self._jwks_ttl:
            return self._jwks_cache
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(self.jwks_url)
            r.raise_for_status()
            self._jwks_cache = r.json()
            self._jwks_cache_ts = now
        return self._jwks_cache

    async def verify(self, token: str) -> dict:
        """Decode + verify a Supabase JWT. Returns the claims dict on success."""
        jwks = await self._fetch_jwks()
        try:
            unverified_header = jwt.get_unverified_header(token)
        except JWTError as e:
            raise PermissionError(f"malformed_token: {e}")

        kid = unverified_header.get("kid")
        key = None
        for k in jwks.get("keys", []):
            if k.get("kid") == kid:
                key = k
                break
        if not key:
            raise PermissionError("unknown_kid")

        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[unverified_header.get("alg", "RS256")],
                audience=self.audience,
                options={"verify_aud": True, "verify_exp": True},
            )
        except JWTError as e:
            raise PermissionError(f"jwt_invalid: {e}")

        return claims


_jwt_verifier: Optional[JwtVerifier] = None


def get_jwt_verifier() -> JwtVerifier:
    global _jwt_verifier
    if _jwt_verifier is None:
        s = get_settings()
        if not s.SUPABASE_URL:
            raise RuntimeError("SUPABASE_URL not set; cannot verify bridge tokens.")
        # Supabase Auth exposes JWKS at /auth/v1/.well-known/jwks.json
        # for projects with asymmetric (RSA/EC) JWT signing enabled. For
        # legacy HS256 projects, this verifier doesn't apply -- use the
        # SERVICE_ROLE secret directly to verify HS256 tokens.
        jwks_url = f"{s.SUPABASE_URL}/auth/v1/.well-known/jwks.json"
        _jwt_verifier = JwtVerifier(jwks_url=jwks_url)
    return _jwt_verifier


# ============================================================================
# Per-call session tokens (correlate cloud + bridge audit)
# ============================================================================


def mint_call_token() -> str:
    """Short opaque token for one call. Used to correlate logs."""
    return f"call_{secrets.token_urlsafe(16)}"
