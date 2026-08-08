"""Official read-only Streamable-HTTP MCP surface for ChatGPT.

The MCP resource server is separate from the embedded provider page. OAuth
identifies the VibeSpace user; an outbound desktop relay supplies only content
under that user's explicit session-only workspace grant.
"""

from typing import Any, Protocol
from urllib.parse import urlsplit

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl, BaseModel, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import JwtVerifier, get_jwt_verifier
from .bridge import BridgeRegistry, BridgeSession, get_browser_chat_bridge_registry
from .config import Settings, get_settings

MAX_MCP_REQUEST_BYTES = 256 * 1024


class BoundedRequestBody:
    """Small ASGI guard for MCP SDK versions predating a native body cap."""

    def __init__(self, app: ASGIApp, limit: int = MAX_MCP_REQUEST_BYTES) -> None:
        self._app = app
        self._limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self._app(scope, receive, send)
            return
        messages: list[Message] = []
        size = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > self._limit:
                    await send(
                        {
                            "type": "http.response.start",
                            "status": 413,
                            "headers": [
                                (b"content-type", b"text/plain; charset=utf-8")
                            ],
                        }
                    )
                    await send(
                        {
                            "type": "http.response.body",
                            "body": b"MCP request body is too large.",
                        }
                    )
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                return
        index = 0

        async def replay() -> Message:
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return {"type": "http.disconnect"}

        await self._app(scope, replay, send)


class RegistryLike(Protocol):
    def get_session(self, user_id: str) -> BridgeSession | None: ...

    async def invoke(
        self,
        user_id: str,
        call_id: str,
        tool_name: str,
        args: dict,
        deadline_ms: int = 8000,
        **kwargs: Any,
    ) -> Any: ...


class WorkspaceSummary(BaseModel):
    id: str
    display_name: str
    read_only: bool = True


class ToolCapability(BaseModel):
    id: str
    label: str
    category: str
    classification: str
    available: bool
    approval_required: bool
    unavailable_reason: str | None = None


class CapabilityResult(BaseModel):
    connected: bool
    workspace: WorkspaceSummary | None = None
    tools: list[str] = Field(default_factory=list)
    catalog: list[ToolCapability] = Field(default_factory=list)
    writes_enabled: bool = False
    terminal_enabled: bool = False


class WorkspaceListResult(BaseModel):
    workspaces: list[WorkspaceSummary] = Field(default_factory=list)


class DirectoryEntry(BaseModel):
    name: str
    is_directory: bool
    size: int | None = None


class DirectoryResult(BaseModel):
    workspace_id: str
    path: str
    entries: list[DirectoryEntry]


class FileReadResult(BaseModel):
    workspace_id: str
    path: str
    content: str


class VibeSpaceAccessToken(AccessToken):
    subject: str


class SupabaseOAuthTokenVerifier:
    """Accept only Supabase OAuth access tokens, not ordinary desktop JWTs."""

    def __init__(self, verifier: JwtVerifier | None = None) -> None:
        self._verifier = verifier

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            claims = await (self._verifier or get_jwt_verifier()).verify(token)
        except (PermissionError, RuntimeError):
            return None
        subject = claims.get("sub")
        client_id = claims.get("client_id")
        if not isinstance(subject, str) or not subject:
            return None
        if not isinstance(client_id, str) or not client_id:
            return None
        raw_scope = claims.get("scope", "")
        scopes = raw_scope.split() if isinstance(raw_scope, str) else []
        expires_at = claims.get("exp")
        return VibeSpaceAccessToken(
            token=token,
            client_id=client_id,
            scopes=scopes,
            expires_at=expires_at if isinstance(expires_at, int) else None,
            subject=subject,
        )


class BrowserChatMcpService:
    def __init__(self, registry: RegistryLike) -> None:
        self._registry = registry

    @staticmethod
    def _catalog(session: BridgeSession | None) -> list[ToolCapability]:
        advertised = session.tool_names if session else frozenset()
        disconnected = None if session else "The VibeSpace desktop relay is offline."

        def read_capability(
            identifier: str, label: str, relay_tool: str
        ) -> ToolCapability:
            available = relay_tool in advertised
            return ToolCapability(
                id=identifier,
                label=label,
                category="files",
                classification="read",
                available=available,
                approval_required=False,
                unavailable_reason=(
                    None
                    if available
                    else disconnected
                    or "This tool is not available in the active workspace grant."
                ),
            )

        mutation_reason = "Requires an approved VibeSpace mutation session."
        return [
            read_capability("files.list", "List project files", "fs.list"),
            read_capability("files.read", "Read a project file", "fs.read"),
            ToolCapability(
                id="files.write",
                label="Write a project file",
                category="files",
                classification="write",
                available=False,
                approval_required=True,
                unavailable_reason=mutation_reason,
            ),
            ToolCapability(
                id="browser.playwright",
                label="Control an approved browser session",
                category="browser",
                classification="browser_mutation",
                available=False,
                approval_required=True,
                unavailable_reason=mutation_reason,
            ),
            ToolCapability(
                id="terminal.run",
                label="Run an approved terminal command",
                category="terminal",
                classification="command",
                available=False,
                approval_required=True,
                unavailable_reason=mutation_reason,
            ),
            ToolCapability(
                id="mcp.invoke",
                label="Use an approved VibeSpace MCP tool",
                category="mcp",
                classification="external_mutation",
                available=False,
                approval_required=True,
                unavailable_reason=mutation_reason,
            ),
        ]

    def capabilities(self, user_id: str) -> CapabilityResult:
        session = self._registry.get_session(user_id)
        if not session:
            return CapabilityResult(connected=False, catalog=self._catalog(None))
        workspace = WorkspaceSummary(
            id=session.workspace_grant_id,
            display_name=session.workspace_display_name,
        )
        return CapabilityResult(
            connected=True,
            workspace=workspace,
            tools=[
                "vibespace.get_capabilities",
                "vibespace.list_workspaces",
                "vibespace.list_directory",
                "vibespace.read_file",
            ],
            catalog=self._catalog(session),
        )

    def list_workspaces(self, user_id: str) -> WorkspaceListResult:
        capability = self.capabilities(user_id)
        return WorkspaceListResult(
            workspaces=[capability.workspace] if capability.workspace else []
        )

    async def list_directory(
        self, user_id: str, workspace_id: str, path: str = "."
    ) -> DirectoryResult:
        session = self._require_workspace(user_id, workspace_id)
        result = await self._invoke(user_id, "fs.list", {"path": path})
        entries = result.get("entries") if isinstance(result, dict) else None
        if not isinstance(entries, list):
            raise ValueError("The local relay returned an invalid directory result.")
        return DirectoryResult(
            workspace_id=session.workspace_grant_id,
            path=str(result.get("path", ".")),
            entries=[
                DirectoryEntry(
                    name=str(entry.get("name", "")),
                    is_directory=entry.get("isDir") is True,
                    size=entry.get("size")
                    if isinstance(entry.get("size"), int)
                    else None,
                )
                for entry in entries
                if isinstance(entry, dict) and isinstance(entry.get("name"), str)
            ],
        )

    async def read_file(
        self, user_id: str, workspace_id: str, path: str
    ) -> FileReadResult:
        session = self._require_workspace(user_id, workspace_id)
        result = await self._invoke(user_id, "fs.read", {"path": path})
        if not isinstance(result, dict) or not isinstance(result.get("content"), str):
            raise ValueError("The local relay returned an invalid file result.")
        return FileReadResult(
            workspace_id=session.workspace_grant_id,
            path=str(result.get("path", path)),
            content=result["content"],
        )

    def _require_workspace(self, user_id: str, workspace_id: str) -> BridgeSession:
        session = self._registry.get_session(user_id)
        if not session or session.workspace_grant_id != workspace_id:
            raise ValueError("The requested workspace is unavailable.")
        return session

    async def _invoke(self, user_id: str, name: str, args: dict) -> Any:
        try:
            return await self._registry.invoke(
                user_id=user_id,
                call_id="mcp_read_request",
                tool_name=name,
                args=args,
                deadline_ms=8_000,
            )
        except RuntimeError as exc:
            raise ValueError("The local read-only relay is unavailable.") from exc


def _authenticated_subject() -> str:
    access_token = get_access_token()
    subject = getattr(access_token, "subject", None)
    if not isinstance(subject, str) or not subject:
        raise ValueError("Authentication is required.")
    return subject


def create_browser_chat_mcp_server(
    settings: Settings | None = None,
    registry: BridgeRegistry | None = None,
    token_verifier: SupabaseOAuthTokenVerifier | None = None,
) -> FastMCP:
    config = settings or get_settings()
    if not config.has_browser_chat_mcp:
        raise RuntimeError(
            "Browser Chat MCP requires HTTPS SUPABASE_URL and MCP_PUBLIC_URL ending in /mcp."
        )
    service = BrowserChatMcpService(registry or get_browser_chat_bridge_registry())
    public_url = config.MCP_PUBLIC_URL.rstrip("/")
    public_host = urlsplit(public_url).netloc
    mcp = FastMCP(
        "VibeSpace MCP",
        instructions=(
            "Use the available VibeSpace tools from the capability catalog. "
            "Read only from the project the user explicitly approved for this "
            "desktop session. Never infer write, terminal, browser, or downstream "
            "MCP authority when the catalog reports it unavailable."
        ),
        token_verifier=token_verifier or SupabaseOAuthTokenVerifier(),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(f"{config.SUPABASE_URL.rstrip('/')}/auth/v1"),
            resource_server_url=AnyHttpUrl(public_url),
            client_registration_options=ClientRegistrationOptions(
                enabled=True,
                valid_scopes=["email", "openid", "profile"],
                default_scopes=["email"],
            ),
            required_scopes=["email"],
        ),
        stateless_http=True,
        json_response=True,
        streamable_http_path="/mcp",
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[public_host],
            allowed_origins=["https://chatgpt.com", "https://chat.openai.com"],
        ),
    )
    read_only = ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )

    @mcp.tool(
        name="vibespace.get_capabilities",
        description="Report the currently connected read-only VibeSpace workspace.",
        annotations=read_only,
        structured_output=True,
    )
    def get_capabilities() -> CapabilityResult:
        return service.capabilities(_authenticated_subject())

    @mcp.tool(
        name="vibespace.list_workspaces",
        description="List the one VibeSpace project explicitly approved for this session.",
        annotations=read_only,
        structured_output=True,
    )
    def list_workspaces() -> WorkspaceListResult:
        return service.list_workspaces(_authenticated_subject())

    @mcp.tool(
        name="vibespace.list_directory",
        description="List one relative directory inside the approved VibeSpace project.",
        annotations=read_only,
        structured_output=True,
    )
    async def list_directory(workspace_id: str, path: str = ".") -> DirectoryResult:
        return await service.list_directory(
            _authenticated_subject(), workspace_id, path
        )

    @mcp.tool(
        name="vibespace.read_file",
        description="Read one bounded text file inside the approved VibeSpace project.",
        annotations=read_only,
        structured_output=True,
    )
    async def read_file(workspace_id: str, path: str) -> FileReadResult:
        return await service.read_file(_authenticated_subject(), workspace_id, path)

    return mcp


def create_browser_chat_mcp_app(settings: Settings | None = None) -> ASGIApp:
    return BoundedRequestBody(
        create_browser_chat_mcp_server(settings).streamable_http_app()
    )
