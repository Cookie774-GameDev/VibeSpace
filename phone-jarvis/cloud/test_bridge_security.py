from __future__ import annotations

import asyncio

import pytest

from .bridge import (
    BridgeRegistry,
    get_bridge_registry,
    get_browser_chat_bridge_registry,
    validate_registration_frame,
    validate_tool_request,
)
from .phone_bridge import PhoneBridgeRegistry


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed: list[tuple[int, str]] = []

    async def send_text(self, value: str) -> None:
        self.sent.append(value)

    async def close(self, code: int, reason: str) -> None:
        self.closed.append((code, reason))


def safe_tools() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": "fs.read",
                "description": "Read one file.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "fs.list",
                "description": "List one directory.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
            },
        },
    ]


def test_registration_accepts_only_v2_read_only_schema_and_drops_local_root() -> None:
    registration = validate_registration_frame(
        {
            "kind": "register",
            "protocol_version": 2,
            "token": "jwt-value",
            "client_nonce": "nonce_1234567890123456",
            "workspace_root": r"C:\Users\viper\Projects\Safe",
            "workspace_grant": {
                "id": "grant_1234567890abcdef",
                "display_name": "Safe",
            },
            "tools": safe_tools(),
            "writable": False,
            "shell_enabled": False,
        }
    )
    assert registration.protocol_version == 2
    assert registration.tool_names == frozenset({"fs.read", "fs.list"})
    assert registration.workspace_grant_id == "grant_1234567890abcdef"
    assert registration.workspace_display_name == "Safe"
    assert not hasattr(registration, "workspace_root")


@pytest.mark.parametrize(
    "patch",
    [
        {"protocol_version": 1},
        {"client_nonce": "short"},
        {"writable": True},
        {"shell_enabled": True},
        {
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "shell.run",
                        "description": "unsafe",
                        "parameters": {"type": "object"},
                    },
                }
            ]
        },
    ],
)
def test_registration_rejects_legacy_write_shell_and_unapproved_tools(
    patch: dict,
) -> None:
    frame = {
        "kind": "register",
        "protocol_version": 2,
        "token": "jwt-value",
        "client_nonce": "nonce_1234567890123456",
        "workspace_grant": {
            "id": "grant_1234567890abcdef",
            "display_name": "Safe",
        },
        "tools": safe_tools(),
        "writable": False,
        "shell_enabled": False,
    }
    frame.update(patch)
    with pytest.raises(ValueError):
        validate_registration_frame(frame)


def test_tool_request_requires_advertised_name_bounded_args_and_deadline() -> None:
    request = validate_tool_request(
        tool_name="fs.read",
        args={"path": "README.md"},
        deadline_ms=8_000,
        advertised_tools=frozenset({"fs.read", "fs.list"}),
    )
    assert request.tool_name == "fs.read"
    assert request.deadline_ms == 8_000
    with pytest.raises(ValueError, match="advertised"):
        validate_tool_request(
            tool_name="shell.run",
            args={"command": "whoami"},
            deadline_ms=8_000,
            advertised_tools=frozenset({"fs.read"}),
        )
    with pytest.raises(ValueError, match="large"):
        validate_tool_request(
            tool_name="fs.read",
            args={"path": "x" * 70_000},
            deadline_ms=8_000,
            advertised_tools=frozenset({"fs.read"}),
        )
    with pytest.raises(ValueError, match="deadline"):
        validate_tool_request(
            tool_name="fs.read",
            args={"path": "README.md"},
            deadline_ms=60_000,
            advertised_tools=frozenset({"fs.read"}),
        )


def test_registry_dispatch_is_session_bound_monotonic_and_expiring() -> None:
    async def scenario() -> None:
        registry = BridgeRegistry()
        ws = FakeWebSocket()
        session = await registry.register(
            ws=ws,
            user_id="user-1",
            registration=validate_registration_frame(
                {
                    "kind": "register",
                    "protocol_version": 2,
                    "token": "jwt-value",
                    "client_nonce": "nonce_1234567890123456",
                    "workspace_grant": {
                        "id": "grant_1234567890abcdef",
                        "display_name": "Safe",
                    },
                    "tools": safe_tools(),
                    "writable": False,
                    "shell_enabled": False,
                }
            ),
            daemon_version="1.5.0",
            platform="win32",
        )

        task = asyncio.create_task(
            registry.invoke(
                user_id="user-1",
                call_id="parent-1",
                tool_name="fs.read",
                args={"path": "README.md"},
                deadline_ms=2_000,
            )
        )
        await asyncio.sleep(0)
        assert len(ws.sent) == 1
        frame = __import__("json").loads(ws.sent[0])
        assert frame["session_id"] == session.session_id
        assert frame["sequence"] == 1
        assert frame["expires_at_ms"] > frame["issued_at_ms"]
        assert frame["name"] == "fs.read"
        await registry.handle_frame(
            session,
            {
                "kind": "tool_result",
                "session_id": session.session_id,
                "call_id": frame["call_id"],
                "sequence": 1,
                "ok": True,
                "result": {"content": "hello"},
            },
        )
        assert await task == {"content": "hello"}

    asyncio.run(scenario())


def test_browser_chat_and_phone_voice_use_distinct_registries() -> None:
    assert isinstance(get_bridge_registry(), PhoneBridgeRegistry)
    assert isinstance(get_browser_chat_bridge_registry(), BridgeRegistry)
    assert get_bridge_registry() is not get_browser_chat_bridge_registry()


def test_phone_voice_registry_preserves_legacy_dispatch_contract() -> None:
    async def scenario() -> None:
        registry = PhoneBridgeRegistry()
        ws = FakeWebSocket()
        session = await registry.register(
            ws=ws,
            user_id="phone-user",
            tools_schema=safe_tools(),
            workspace_root=r"C:\Users\viper",
            daemon_version="1.5.0",
            platform="win32",
        )

        task = asyncio.create_task(
            registry.invoke(
                user_id="phone-user",
                call_id="phone-parent",
                tool_name="fs.read",
                args={"path": "README.md"},
                deadline_ms=2_000,
            )
        )
        await asyncio.sleep(0)
        frame = __import__("json").loads(ws.sent[0])
        assert frame["parent_call_id"] == "phone-parent"
        assert frame["confirmed"] is True
        await registry.handle_frame(
            session,
            {
                "kind": "tool_result",
                "call_id": frame["call_id"],
                "ok": True,
                "result": {"content": "legacy"},
            },
        )
        assert await task == {"content": "legacy"}

    asyncio.run(scenario())
