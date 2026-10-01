from __future__ import annotations

import asyncio
from typing import Any

import pytest
from starlette.testclient import TestClient

from .bridge import BridgeSession
from .browser_chat_mcp import (
    BoundedRequestBody,
    BrowserChatMcpService,
    MAX_MCP_REQUEST_BYTES,
    SupabaseOAuthTokenVerifier,
    create_browser_chat_mcp_server,
)
from .config import Settings

class FakeVerifier:
    def __init__(self, claims: dict[str, Any]) -> None:
        self.claims = claims

    async def verify(self, token: str) -> dict[str, Any]:
        assert token == "oauth-token"
        return self.claims


class FakeRegistry:
    def __init__(self, active_session: BridgeSession | None) -> None:
        self.session = active_session
        self.calls: list[tuple[str, str, dict]] = []

    def get_session(self, user_id: str) -> BridgeSession | None:
        return (
            self.session if self.session and self.session.user_id == user_id else None
        )

    async def invoke(
        self,
        user_id: str,
        call_id: str,
        tool_name: str,
        args: dict,
        deadline_ms: int = 8000,
        **_: Any,
    ) -> Any:
        assert call_id == "mcp_read_request"
        assert deadline_ms == 8_000
        self.calls.append((user_id, tool_name, args))
        if tool_name == "fs.list":
            return {
                "path": ".",
                "entries": [{"name": "README.md", "isDir": False, "size": 42}],
            }
        return {"path": "README.md", "content": "hello"}


def active_session() -> BridgeSession:
    return BridgeSession(
        session_id="br_1234567890abcdef",
        user_id="user-1",
        ws=object(),  # type: ignore[arg-type]
        tools_schema=[],
        tool_names=frozenset({"fs.list", "fs.read"}),
        client_nonce="nonce_1234567890123456",
        server_nonce="nonce_abcdef1234567890",
        workspace_grant_id="grant_1234567890abcdef",
        workspace_display_name="Safe project",
    )


def test_oauth_verifier_requires_subject_and_oauth_client_id() -> None:
    async def scenario() -> None:
        accepted = await SupabaseOAuthTokenVerifier(
            FakeVerifier(
                {
                    "sub": "user-1",
                    "client_id": "chatgpt-client",
                    "scope": "email profile",
                    "exp": 2_000_000_000,
                    "role": "authenticated",
                }
            )  # type: ignore[arg-type]
        ).verify_token("oauth-token")
        assert accepted is not None
        assert accepted.subject == "user-1"
        assert accepted.client_id == "chatgpt-client"
        assert accepted.scopes == ["email", "profile"]

        rejected = await SupabaseOAuthTokenVerifier(
            FakeVerifier({"sub": "user-1", "scope": "email"})  # type: ignore[arg-type]
        ).verify_token("oauth-token")
        assert rejected is None

    asyncio.run(scenario())


def test_service_lists_only_the_bound_opaque_workspace_and_read_tools() -> None:
    service = BrowserChatMcpService(FakeRegistry(active_session()))
    capability = service.capabilities("user-1")
    assert capability.connected is True
    assert capability.workspace is not None
    assert capability.workspace.id == "grant_1234567890abcdef"
    assert "vibespace.read_file" in capability.tools
    assert capability.writes_enabled is False
    assert capability.terminal_enabled is False
    assert "C:\\" not in capability.model_dump_json()


def test_service_publishes_a_classified_vibespace_tool_catalog() -> None:
    service = BrowserChatMcpService(FakeRegistry(active_session()))
    capability = service.capabilities("user-1")

    catalog = {tool.id: tool for tool in capability.catalog}
    assert catalog["files.list"].model_dump() == {
        "id": "files.list",
        "label": "List project files",
        "category": "files",
        "classification": "read",
        "available": True,
        "approval_required": False,
        "unavailable_reason": None,
    }
    assert catalog["files.read"].available is True
    assert catalog["files.write"].model_dump() == {
        "id": "files.write",
        "label": "Write a project file",
        "category": "files",
        "classification": "write",
        "available": False,
        "approval_required": True,
        "unavailable_reason": "Requires an approved VibeSpace mutation session.",
    }
    assert catalog["browser.playwright"].classification == "browser_mutation"
    assert catalog["browser.playwright"].available is False
    assert catalog["terminal.run"].classification == "command"
    assert catalog["terminal.run"].approval_required is True
    assert all(tool.id.startswith(("files.", "browser.", "terminal.", "mcp.")) for tool in capability.catalog)


def test_service_dispatches_relative_reads_and_rejects_wrong_workspace() -> None:
    async def scenario() -> None:
        registry = FakeRegistry(active_session())
        service = BrowserChatMcpService(registry)
        listing = await service.list_directory("user-1", "grant_1234567890abcdef", ".")
        assert listing.entries[0].name == "README.md"
        read = await service.read_file("user-1", "grant_1234567890abcdef", "README.md")
        assert read.content == "hello"
        assert registry.calls == [
            ("user-1", "fs.list", {"path": "."}),
            ("user-1", "fs.read", {"path": "README.md"}),
        ]
        with pytest.raises(ValueError, match="workspace"):
            await service.read_file("user-1", "grant_wrongwrongwrong", "README.md")

    asyncio.run(scenario())


def test_server_advertises_exactly_four_read_only_tools() -> None:
    async def scenario() -> None:
        server = create_browser_chat_mcp_server(
            settings=Settings(
                _env_file=None,
                SUPABASE_URL="https://project.supabase.co",
                MCP_PUBLIC_URL="https://cloud.vibespace.test/mcp",
            ),
            registry=FakeRegistry(active_session()),  # type: ignore[arg-type]
            token_verifier=SupabaseOAuthTokenVerifier(
                FakeVerifier(
                    {
                        "sub": "user-1",
                        "client_id": "chatgpt-client",
                        "scope": "email",
                    }
                )  # type: ignore[arg-type]
            ),
        )
        tools = await server.list_tools()
        assert server.name == "VibeSpace MCP"
        assert [tool.name for tool in tools] == [
            "vibespace.get_capabilities",
            "vibespace.list_workspaces",
            "vibespace.list_directory",
            "vibespace.read_file",
        ]
        assert all(tool.annotations and tool.annotations.readOnlyHint for tool in tools)
        assert all(
            tool.annotations and not tool.annotations.destructiveHint for tool in tools
        )

    asyncio.run(scenario())


def test_streamable_http_initializes_and_publishes_oauth_resource_metadata() -> None:
    server = create_browser_chat_mcp_server(
        settings=Settings(
            _env_file=None,
            SUPABASE_URL="https://project.supabase.co",
            MCP_PUBLIC_URL="https://cloud.vibespace.test/mcp",
        ),
        registry=FakeRegistry(active_session()),  # type: ignore[arg-type]
        token_verifier=SupabaseOAuthTokenVerifier(
            FakeVerifier(
                {
                    "sub": "user-1",
                    "client_id": "chatgpt-client",
                    "scope": "email",
                    "exp": 2_000_000_000,
                }
            )  # type: ignore[arg-type]
        ),
    )
    with TestClient(
        BoundedRequestBody(server.streamable_http_app()),
        base_url="https://cloud.vibespace.test",
    ) as client:
        response = client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer oauth-token",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["result"]["serverInfo"]["name"] == "VibeSpace MCP"

        tool_call = client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer oauth-token",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "vibespace.read_file",
                    "arguments": {
                        "workspace_id": "grant_1234567890abcdef",
                        "path": "README.md",
                    },
                },
            },
        )
        assert tool_call.status_code == 200
        assert tool_call.json()["result"]["structuredContent"] == {
            "workspace_id": "grant_1234567890abcdef",
            "path": "README.md",
            "content": "hello",
        }

        metadata = client.get("/.well-known/oauth-protected-resource/mcp")
        assert metadata.status_code == 200
        assert metadata.json() == {
            "resource": "https://cloud.vibespace.test/mcp",
            "authorization_servers": ["https://project.supabase.co/auth/v1"],
            "scopes_supported": ["email"],
            "bearer_methods_supported": ["header"],
        }

        rejected_host = client.post(
            "/mcp",
            headers={
                "Host": "attacker.invalid",
                "Authorization": "Bearer oauth-token",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
        )
        assert rejected_host.status_code == 421

        oversized = client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer oauth-token",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            content=b"x" * (MAX_MCP_REQUEST_BYTES + 1),
        )
        assert oversized.status_code == 413
