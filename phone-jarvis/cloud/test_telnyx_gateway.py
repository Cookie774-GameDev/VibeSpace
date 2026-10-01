from __future__ import annotations

from datetime import UTC, datetime, timedelta

from .telnyx_gateway import (
    ProviderUsage,
    TelnyxMediaSession,
    build_opening_disclosure,
    credits_for_usage,
    recipient_requested_termination,
    recipient_requested_opt_out,
    requires_live_approval,
)


def test_opening_is_always_an_honest_ai_disclosure() -> None:
    opening = build_opening_disclosure("Alex", "ask when the restaurant closes")
    assert "VibeSPACE AI assistant" in opening
    assert "on behalf of Alex" in opening
    assert "ask when the restaurant closes" in opening


def test_protected_actions_pause_for_live_approval() -> None:
    assert requires_live_approval("They require a $20 cancellation deposit.")
    assert requires_live_approval("Please provide the payment card number.")
    assert requires_live_approval("This would confirm the paid order.")
    assert not requires_live_approval("The restaurant closes at 10 PM.")
    assert recipient_requested_termination("Thank you, goodbye.")
    assert recipient_requested_termination("Please hang up now")
    assert not recipient_requested_termination("What time do you close?")
    assert recipient_requested_opt_out("Do not call me again.")
    assert recipient_requested_opt_out("Stop calling this number")
    assert not recipient_requested_opt_out("Please call me again tomorrow")


def test_session_enforces_maximum_duration_and_approval_state() -> None:
    started = datetime(2026, 8, 2, tzinfo=UTC)
    session = TelnyxMediaSession(
        job_id="22222222-2222-4222-8222-222222222222",
        maximum_duration_seconds=300,
        started_at=started,
    )
    assert not session.expired(started + timedelta(seconds=299))
    assert session.expired(started + timedelta(seconds=300))
    assert session.request_live_approval("deposit_required") is True
    assert session.request_live_approval("another_action") is False
    session.resolve_live_approval(False)
    assert session.awaiting_live_approval is None


def test_actual_provider_usage_settles_to_credits_without_exceeding_reservation() -> None:
    usage = ProviderUsage(
        telnyx_transport_usd=0.012,
        deepgram_stt_usd=0.021,
        deepgram_tts_usd=0.014,
        deepseek_usd=0.007,
    )
    assert credits_for_usage(usage, reserved_credits=480) == 54
    assert credits_for_usage(
        ProviderUsage(telnyx_transport_usd=1), reserved_credits=480
    ) == 480
