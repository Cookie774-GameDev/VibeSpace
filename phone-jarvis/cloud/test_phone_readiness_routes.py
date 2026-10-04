"""Local route contracts; SDK token signing is real, provider/media calls are mocked."""

from __future__ import annotations

import importlib
import asyncio
import sys
import threading
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock
from xml.etree import ElementTree

import jwt
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from twilio.request_validator import RequestValidator

from .config import Settings
from . import security

USER_ID = "11111111-1111-4111-8111-111111111111"
CALL_SID = "CA" + "1" * 32
BASE = "https://phone.example.test"
FORM = {"From": "+15555550101", "To": "+15555550102", "CallSid": CALL_SID}


@pytest.fixture
def routes(monkeypatch):
    pytest.importorskip("livekit.api")
    # Pipecat audio execution is intentionally excluded from local route tests.
    pipeline = ModuleType(f"{__package__}.pipeline")
    pipeline.CallContext = SimpleNamespace
    pipeline.ProviderKeys = SimpleNamespace
    pipeline.build_pipeline_task = Mock(side_effect=AssertionError("no media pipeline"))
    monkeypatch.setitem(sys.modules, pipeline.__name__, pipeline)
    database_module = ModuleType(f"{__package__}.supabase_client")
    database_module.get_supabase = Mock(side_effect=AssertionError("no live database"))
    monkeypatch.setitem(sys.modules, database_module.__name__, database_module)
    modules = {
        name: importlib.import_module(f"{__package__}.{name}")
        for name in ("main", "twilio_handler", "outbound", "livekit_handler")
    }
    settings = Settings(
        _env_file=None,
        PHONE_JARVIS_ENABLED=True,
        PHONE_JARVIS_PUBLIC_BASE_URL=BASE,
        BRIDGE_TOKEN_PEPPER="ab" * 32,
        TWILIO_ACCOUNT_SID="AC" + "1" * 32,
        TWILIO_AUTH_TOKEN="local-test-auth-token",
        TWILIO_PHONE_NUMBER=FORM["To"],
        LIVEKIT_API_KEY="local-test-key",
        LIVEKIT_API_SECRET="local-test-livekit-secret-32-characters",
        LIVEKIT_URL="wss://livekit.example.test",
        SUPABASE_URL="https://supabase.example.test",
        SUPABASE_SERVICE_ROLE_KEY="local-test-service-role",
    )
    for module in [security, *modules.values()]:
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    twilio = modules["twilio_handler"]
    outbound = modules["outbound"]
    livekit = modules["livekit_handler"]
    monkeypatch.setattr(
        twilio, "_user_for_phone_number", AsyncMock(return_value=USER_ID)
    )
    monkeypatch.setattr(
        twilio,
        "_phone_settings_for_user",
        AsyncMock(return_value={"caller_allowlist": [FORM["From"]]}),
    )
    database = Mock()
    database.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "user_id": USER_ID,
        "context": {"authorization": "secret"},
        "reason": "manual",
    }
    monkeypatch.setattr(outbound, "get_supabase", lambda: database)
    monkeypatch.setattr(
        outbound,
        "_phone_settings",
        AsyncMock(
            return_value={
                "user_phone_number": FORM["From"],
                "outbound_triggers": {},
            }
        ),
    )
    provider = Mock()
    provider.calls.create.return_value = SimpleNamespace(sid=CALL_SID)
    provider.messages.create.return_value = SimpleNamespace(
        sid="SM-local", status="queued"
    )
    monkeypatch.setattr(outbound, "TwilioClient", Mock(return_value=provider))
    verifier = SimpleNamespace(verify=AsyncMock(return_value={"sub": USER_ID}))
    for module in (outbound, livekit):
        monkeypatch.setattr(module, "get_jwt_verifier", lambda: verifier)
    audit = SimpleNamespace(log_call_start=AsyncMock(), log_call_end=AsyncMock())
    monkeypatch.setattr(livekit, "get_audit_logger", lambda: audit)
    monkeypatch.setattr(twilio, "get_audit_logger", lambda: audit)
    return SimpleNamespace(
        **modules,
        settings=settings,
        database=database,
        provider=provider,
        audit=audit,
        client=TestClient(modules["main"].app),
    )


def signed_headers(settings, path, params=None):
    return {
        "x-twilio-signature": RequestValidator(
            settings.TWILIO_AUTH_TOKEN
        ).compute_signature(BASE + path, params or {})
    }


def test_disabled_service_blocks_http_and_websocket_before_provider_work(routes):
    routes.settings.PHONE_JARVIS_ENABLED = False
    response = routes.client.post(
        "/outbound/call", json={}, headers={"authorization": "Bearer local"}
    )
    assert response.status_code == 503
    routes.provider.calls.create.assert_not_called()
    with pytest.raises(WebSocketDisconnect) as disconnected:
        with routes.client.websocket_connect("/twilio/" + CALL_SID):
            pass
    assert disconnected.value.code == 1013
    health = routes.client.get("/health")
    assert health.status_code == 200
    assert health.json()["enabled"] is False
    assert not any(health.json()["transports"].values())


@pytest.mark.parametrize("path", ["/twiml", "/outbound/twiml"])
def test_unsigned_twilio_callback_cannot_reach_user_or_database(routes, path):
    response = routes.client.post(path, data=FORM)
    assert response.status_code == 403
    routes.twilio_handler._user_for_phone_number.assert_not_awaited()
    routes.database.table.assert_not_called()


def test_signed_inbound_callback_uses_canonical_origin_and_bound_media_token(routes):
    headers = signed_headers(routes.settings, "/twiml", FORM)
    headers["host"] = "untrusted.example.test"
    response = routes.client.post("/twiml", data=FORM, headers=headers)
    assert response.status_code == 200
    stream = ElementTree.fromstring(response.text).find("./Connect/Stream")
    assert (
        stream.attrib["url"] == BASE.replace("https:", "wss:") + "/twilio/" + CALL_SID
    )
    params = {item.attrib["name"]: item.attrib["value"] for item in stream}
    claims = security.verify_one_time_token(
        params["session_token"],
        purpose="twilio_media",
        call_sid=CALL_SID,
    )
    assert claims["sub"] == USER_ID
    assert claims["from_number"] == FORM["From"]
    assert claims["caller_preauth"] is True
    with pytest.raises(PermissionError, match="token_replayed"):
        security.verify_one_time_token(
            params["session_token"], purpose="twilio_media", call_sid=CALL_SID
        )


def test_signed_outbound_callback_rejects_missing_pending_owner(routes):
    routes.database.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {}
    response = routes.client.post(
        "/outbound/twiml",
        data=FORM,
        headers=signed_headers(routes.settings, "/outbound/twiml", FORM),
    )
    assert response.status_code == 404


def test_signed_outbound_callback_sanitizes_context_inside_bound_token(routes):
    response = routes.client.post(
        "/outbound/twiml",
        data=FORM,
        headers=signed_headers(routes.settings, "/outbound/twiml", FORM),
    )
    assert response.status_code == 200
    stream = ElementTree.fromstring(response.text).find("./Connect/Stream")
    params = {item.attrib["name"]: item.attrib["value"] for item in stream}
    claims = security.verify_one_time_token(
        params["session_token"], purpose="twilio_media", call_sid=CALL_SID
    )
    assert claims["sub"] == USER_ID
    assert claims["outbound_context"]["authorization"] == "[redacted]"


def test_media_websocket_rejects_unsigned_upgrade(routes):
    with pytest.raises(WebSocketDisconnect) as disconnected:
        with routes.client.websocket_connect("/twilio/" + CALL_SID):
            pass
    assert disconnected.value.code == 1008


@pytest.mark.parametrize("scheme,suffix", [("https", ""), ("wss", ""), ("wss", "/")])
def test_signed_media_stream_cannot_supply_its_own_user_or_preauth(
    routes, scheme, suffix
):
    path = "/twilio/" + CALL_SID
    signature = RequestValidator(routes.settings.TWILIO_AUTH_TOKEN).compute_signature(
        BASE.replace("https:", scheme + ":") + path + suffix,
        {},
    )
    with routes.client.websocket_connect(
        path, headers={"x-twilio-signature": signature}
    ) as websocket:
        websocket.send_json(
            {
                "event": "start",
                "start": {
                    "callSid": CALL_SID,
                    "streamSid": "MZ-local",
                    "customParameters": {
                        "user_id": USER_ID,
                        "caller_preauth": "true",
                        "session_token": "forged",
                    },
                },
            }
        )
        with pytest.raises(WebSocketDisconnect) as disconnected:
            websocket.receive_json()
    assert disconnected.value.code == 1008


def test_livekit_token_uses_real_pinned_sdk_and_one_hour_room_grant(
    routes, monkeypatch
):
    def close_background(coroutine):
        coroutine.close()

    monkeypatch.setattr(routes.livekit_handler.asyncio, "create_task", close_background)
    response = routes.client.post(
        "/livekit/token",
        json={"persona": "jarvis"},
        headers={"authorization": "Bearer local"},
    )
    assert response.status_code == 200
    body = response.json()
    claims = jwt.decode(
        body["token"], routes.settings.LIVEKIT_API_SECRET, algorithms=["HS256"]
    )
    assert claims["exp"] - claims["nbf"] == 3600
    assert claims["video"]["room"] == body["room"]
    assert claims["video"]["roomJoin"] is True


def test_outbound_call_uses_operator_callback_origin(routes):
    response = routes.client.post(
        "/outbound/call",
        json={"reason": "manual"},
        headers={"authorization": "Bearer local", "host": "untrusted.example.test"},
    )
    assert response.status_code == 200
    args = routes.provider.calls.create.call_args.kwargs
    assert args["url"] == BASE + "/outbound/twiml"
    assert args["to"] == FORM["From"]


def test_legacy_sms_endpoint_cannot_bypass_canonical_billing(routes):
    response = routes.client.post(
        "/outbound/message",
        json={"message": "local test"},
        headers={"authorization": "Bearer local"},
    )
    assert response.status_code == 410
    routes.provider.messages.create.assert_not_called()


def fake_media_stack(monkeypatch):
    runner = SimpleNamespace(run=AsyncMock())
    serializer = ModuleType("pipecat.serializers.twilio")
    serializer.TwilioFrameSerializer = Mock()
    websocket_transport = ModuleType("pipecat.transports.network.fastapi_websocket")
    websocket_transport.FastAPIWebsocketParams = SimpleNamespace
    websocket_transport.FastAPIWebsocketTransport = Mock()
    livekit_transport = ModuleType("pipecat.transports.services.livekit")
    livekit_transport.LiveKitParams = SimpleNamespace
    livekit_transport.LiveKitTransport = Mock()
    runner_module = ModuleType("pipecat.pipeline.runner")
    runner_module.PipelineRunner = lambda: runner
    for module in (serializer, websocket_transport, livekit_transport, runner_module):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    return runner, livekit_transport


def test_valid_media_binding_ignores_forged_custom_identity(routes, monkeypatch):
    fake_media_stack(monkeypatch)
    twilio = routes.twilio_handler
    built = threading.Event()

    def record_build(*args):
        built.set()
        return "local-pipeline"

    build = Mock(side_effect=record_build)
    monkeypatch.setattr(twilio, "build_pipeline_task", build)
    monkeypatch.setattr(
        twilio, "_resolve_keys_for_user", AsyncMock(return_value=SimpleNamespace())
    )
    bridge = Mock()
    bridge.get_tools_schema.return_value = []
    monkeypatch.setattr(twilio, "get_bridge_registry", lambda: bridge)
    token = security.mint_one_time_token(
        purpose="twilio_media",
        subject=USER_ID,
        call_sid=CALL_SID,
        claims={"from_number": FORM["From"], "caller_preauth": False},
    )
    path = "/twilio/" + CALL_SID
    with routes.client.websocket_connect(
        path, headers=signed_headers(routes.settings, path)
    ) as websocket:
        websocket.send_json(
            {
                "event": "start",
                "start": {
                    "callSid": CALL_SID,
                    "streamSid": "MZ-local",
                    "customParameters": {
                        "session_token": token,
                        "user_id": "forged",
                        "caller_preauth": "true",
                    },
                },
            }
        )
        assert built.wait(timeout=3)
    context = build.call_args.args[1]
    assert context.user_id == USER_ID
    assert context.confirmed_pin is False
    assert build.call_args.args[3] == []
    bridge.get_tools_schema.assert_not_called()


def test_livekit_agent_signs_real_room_token_before_mocked_media_execution(
    routes, monkeypatch
):
    runner, transport = fake_media_stack(monkeypatch)
    livekit = routes.livekit_handler
    monkeypatch.setattr(
        livekit, "_resolve_keys_for_user", AsyncMock(return_value=SimpleNamespace())
    )
    monkeypatch.setattr(
        livekit, "build_pipeline_task", Mock(return_value="local-pipeline")
    )
    bridge = Mock()
    bridge.is_connected.return_value = True
    bridge.get_tools_schema.return_value = []
    monkeypatch.setattr(livekit, "get_bridge_registry", lambda: bridge)
    asyncio.run(livekit._spawn_agent("local-room", USER_ID, "local-call-id", "jarvis"))
    claims = jwt.decode(
        transport.LiveKitTransport.call_args.kwargs["token"],
        routes.settings.LIVEKIT_API_SECRET,
        algorithms=["HS256"],
    )
    assert claims["video"]["room"] == "local-room"
    assert claims["exp"] - claims["nbf"] == 3600
    runner.run.assert_awaited_once_with("local-pipeline")
