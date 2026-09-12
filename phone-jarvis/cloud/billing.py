"""Server-authoritative Phone Jarvis budget reservation helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
import time
from typing import Any

USD_PER_CALL_MINUTE = 0.1
MAX_CALL_SECONDS = 1_800
MIN_CALL_SECONDS = 60
CALLS_PER_MINUTE = 3
TERMINAL_FAILURE_STATUSES = {"busy", "failed", "no-answer", "canceled"}


def estimate_call_cost_usd(seconds: int | float) -> float:
    return max(0.0, float(seconds)) / 60.0 * USD_PER_CALL_MINUTE


def terminal_call_settlement(
    provider_status: str,
    provider_duration: str | int | None,
) -> tuple[str, int] | None:
    """Map a terminal Twilio callback to one idempotent ledger transition."""
    normalized = str(provider_status or "").strip().lower()
    if normalized in TERMINAL_FAILURE_STATUSES:
        return "released", 0
    if normalized != "completed":
        return None
    try:
        duration = max(0, int(provider_duration or 0))
    except (TypeError, ValueError):
        duration = 0
    return "settled", duration


def remaining_call_timeout(
    started_at: float,
    reserved_seconds: int,
    *,
    now: float | None = None,
) -> float:
    current = time.monotonic() if now is None else now
    return max(0.0, float(reserved_seconds) - max(0.0, current - started_at))


def bounded_elapsed_seconds(
    started_at: float,
    reserved_seconds: int,
    *,
    now: float | None = None,
) -> int:
    current = time.monotonic() if now is None else now
    elapsed = max(0.0, current - started_at)
    return min(max(0, int(reserved_seconds)), math.ceil(elapsed))


@dataclass(frozen=True)
class Reservation:
    ok: bool
    reservation_id: str | None = None
    reason: str | None = None
    duplicate: bool = False
    provider_reference: str | None = None
    reserved_seconds: int | None = None
    remaining_usd: float | None = None


class BillingService:
    def __init__(self, client=None) -> None:
        self._client = client

    @property
    def client(self):
        if self._client is not None:
            return self._client
        from .supabase_client import get_supabase
        return get_supabase()

    def reserve_call(
        self,
        user_id: str,
        *,
        estimate_usd: float,
        idempotency_key: str,
        estimated_seconds: int,
    ) -> Reservation:
        try:
            response = self.client.rpc("reserve_usage_budget", {
                "p_user_id": user_id,
                "p_kind": "call",
                "p_estimate_usd": max(0.0, estimate_usd),
                "p_idempotency_key": idempotency_key,
                "p_count": max(0, int(estimated_seconds)),
                "p_context": {"provider": "phone_jarvis", "operation": "voice_call"},
            }).execute()
            data = response.data
            if not isinstance(data, dict) or data.get("ok") is not True:
                reason = data.get("reason") if isinstance(data, dict) else "usage_unavailable"
                remaining = data.get("remaining_usd") if isinstance(data, dict) else None
                return Reservation(
                    ok=False,
                    reason=str(reason or "usage_unavailable"),
                    remaining_usd=(
                        float(remaining)
                        if isinstance(remaining, (int, float))
                        else None
                    ),
                )
            reservation_id = data.get("reservation_id")
            if not isinstance(reservation_id, str):
                return Reservation(ok=False, reason="usage_unavailable")
            return Reservation(
                ok=True,
                reservation_id=reservation_id,
                duplicate=bool(data.get("duplicate")),
                provider_reference=data.get("provider_reference") if isinstance(data.get("provider_reference"), str) else None,
                reserved_seconds=(
                    int(data["reserved_count"])
                    if isinstance(data.get("reserved_count"), (int, float))
                    else max(0, int(estimated_seconds))
                ),
            )
        except Exception:
            return Reservation(ok=False, reason="usage_unavailable")

    def reserve_bounded_call(
        self,
        user_id: str,
        *,
        idempotency_key: str,
        max_seconds: int = MAX_CALL_SECONDS,
        min_seconds: int = MIN_CALL_SECONDS,
    ) -> Reservation:
        maximum = max(1, int(max_seconds))
        minimum = max(1, int(min_seconds))
        if maximum < minimum:
            return Reservation(ok=False, reason="invalid_reservation")

        try:
            window_start = datetime.now(timezone.utc).replace(
                second=0, microsecond=0
            ).isoformat()
            response = self.client.rpc("voice_rate_limit_hit", {
                "p_user_id": user_id,
                "p_window_start": window_start,
                "p_chars": 0,
                "p_max_requests": CALLS_PER_MINUTE,
            }).execute()
            rate_data = response.data
            if not isinstance(rate_data, dict):
                return Reservation(ok=False, reason="usage_unavailable")
            if rate_data.get("limited") is True:
                return Reservation(ok=False, reason="rate_limited")
        except Exception:
            return Reservation(ok=False, reason="usage_unavailable")

        seconds = maximum
        last_failure = Reservation(ok=False, reason="usage_unavailable")
        for _ in range(4):
            reservation = self.reserve_call(
                user_id,
                estimate_usd=estimate_call_cost_usd(seconds),
                idempotency_key=idempotency_key,
                estimated_seconds=seconds,
            )
            if reservation.ok:
                reserved_seconds = reservation.reserved_seconds
                if (
                    reserved_seconds is None
                    or reserved_seconds < minimum
                    or reserved_seconds > maximum
                ):
                    return Reservation(ok=False, reason="usage_unavailable")
                return reservation

            last_failure = reservation
            remaining_usd = reservation.remaining_usd
            if remaining_usd is None or remaining_usd <= 0:
                return reservation
            affordable = int(
                (remaining_usd + (USD_PER_CALL_MINUTE / 60.0) * 1e-9)
                / (USD_PER_CALL_MINUTE / 60.0)
            )
            next_seconds = min(seconds - 1, affordable, maximum)
            if next_seconds < minimum:
                return reservation
            seconds = next_seconds
        return last_failure

    def settle_call(
        self,
        user_id: str,
        reservation_id: str,
        *,
        actual_usd: float,
        actual_seconds: int,
        status: str = "settled",
    ) -> bool:
        try:
            response = self.client.rpc("settle_usage_budget", {
                "p_user_id": user_id,
                "p_reservation_id": reservation_id,
                "p_actual_usd": max(0.0, actual_usd),
                "p_actual_count": max(0, int(actual_seconds)),
                "p_status": status,
            }).execute()
            return isinstance(response.data, dict) and response.data.get("ok") is True
        except Exception:
            return False

    def attach_provider_reference(self, user_id: str, reservation_id: str, reference: str) -> bool:
        try:
            response = self.client.rpc("attach_usage_provider_reference", {
                "p_user_id": user_id,
                "p_reservation_id": reservation_id,
                "p_provider_reference": reference,
            }).execute()
            return response.data is True
        except Exception:
            return False

    def claim_call(self, user_id: str, reservation_id: str, reference: str) -> bool:
        """Atomically consume one live call reservation across all app instances."""
        try:
            response = self.client.rpc("claim_usage_reservation", {
                "p_user_id": user_id,
                "p_reservation_id": reservation_id,
                "p_kind": "call",
                "p_provider_reference": reference,
            }).execute()
            return response.data is True
        except Exception:
            return False


_billing: BillingService | None = None


def get_billing_service() -> BillingService:
    global _billing
    if _billing is None:
        _billing = BillingService()
    return _billing
