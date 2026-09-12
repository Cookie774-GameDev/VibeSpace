# VibeSpace MCP One-Click Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Browser Chat MCP button into a bounded preflight and exact ChatGPT Plugins handoff while keeping mandatory ChatGPT owner consent truthful.

**Architecture:** A pure `mcpConnection.ts` module validates the canonical HTTPS `/mcp` resource and its OAuth discovery chain with bounded, cancellable requests. The existing provider-surface controller gains one exact ChatGPT Plugins handoff that continues to use the operating system’s default browser. `BrowserChatHub` owns only transient user-initiated setup state and leaves the existing authenticated relay as the connectivity authority.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Tauri safe external-open bridge.

## Global Constraints

- Keep the current Browser Chat layout intact.
- Never inject into ChatGPT, inspect browser sessions, scrape credentials, alter account settings, or fabricate a connected state.
- Open exactly `https://chatgpt.com/plugins` through the operating system’s default browser.
- Preflight runs only after Connect or Retry; add no poller, dependency, telemetry, or persistent token state.
- Preserve existing workspace grants, ticket issuance, relay reconnect behavior, provider surfaces, and protected unrelated dirty paths.

---

### Task 1: Bounded MCP discovery preflight

**Files:**

- Create: `app/src/features/browser-chat/mcpConnection.ts`
- Create: `app/src/features/browser-chat/mcpConnection.test.ts`

**Interfaces:**

- Consumes: a canonical MCP URL, an optional `fetch` implementation, an optional `AbortSignal`, and a bounded timeout.
- Produces: `CHATGPT_PLUGINS_URL`, `McpConnectionPreflightResult`, `McpConnectionPreflightError`, and `preflightVibeSpaceMcp(mcpUrl, options)`.

- [ ] **Step 1: Write failing validation and success tests**

```ts
it('validates health and the complete OAuth discovery chain', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      Response.json({
        resource: 'https://vibespace.example/mcp',
        authorization_servers: ['https://auth.example/auth/v1'],
      }),
    )
    .mockResolvedValueOnce(Response.json({ issuer: 'https://auth.example/auth/v1' }));

  await expect(
    preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
  ).resolves.toEqual({
    mcpUrl: 'https://vibespace.example/mcp',
    authorizationServer: 'https://auth.example/auth/v1',
  });
});

it.each([
  'http://vibespace.example/mcp',
  'https://user:secret@vibespace.example/mcp',
  'https://vibespace.example/not-mcp',
  'https://vibespace.example/mcp?token=secret',
])('rejects an unsafe MCP resource before network access: %s', async (mcpUrl) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(preflightVibeSpaceMcp(mcpUrl, { fetcher })).rejects.toThrow(
    /valid HTTPS MCP endpoint/i,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- --run src/features/browser-chat/mcpConnection.test.ts`

Expected: FAIL because `mcpConnection.ts` does not exist.

- [ ] **Step 3: Implement canonical validation and discovery**

```ts
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

export interface McpConnectionPreflightResult {
  readonly mcpUrl: string;
  readonly authorizationServer: string;
}

export interface McpConnectionPreflightOptions {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class McpConnectionPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionPreflightError';
  }
}

function requireMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpConnectionPreflightError('Enter a valid HTTPS MCP endpoint.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/mcp' ||
    url.search ||
    url.hash
  ) {
    throw new McpConnectionPreflightError('Enter a valid HTTPS MCP endpoint.');
  }
  return url;
}

function authorizationMetadataUrl(value: string): URL {
  const issuer = new URL(value);
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
  }
  const metadata = new URL(issuer.origin);
  metadata.pathname = `/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/u, '')}`;
  return metadata;
}

export async function preflightVibeSpaceMcp(
  mcpUrl: string,
  options: McpConnectionPreflightOptions = {},
): Promise<McpConnectionPreflightResult> {
  const endpoint = requireMcpUrl(mcpUrl);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 5_000);
  const requestJson = async (url: URL, label: string): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new McpConnectionPreflightError(`${label} is unavailable.`);
    }
    return (await response.json()) as Record<string, unknown>;
  };

  try {
    const health = new URL('/health', endpoint);
    const healthResponse = await fetcher(health, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!healthResponse.ok) {
      throw new McpConnectionPreflightError('The VibeSpace MCP health check failed.');
    }
    const protectedResource = new URL('/.well-known/oauth-protected-resource', endpoint);
    const resourceMetadata = await requestJson(
      protectedResource,
      'VibeSpace MCP discovery metadata',
    );
    const authorizationServer = Array.isArray(resourceMetadata.authorization_servers)
      ? resourceMetadata.authorization_servers[0]
      : undefined;
    if (
      resourceMetadata.resource !== endpoint.toString() ||
      typeof authorizationServer !== 'string'
    ) {
      throw new McpConnectionPreflightError('The VibeSpace MCP discovery metadata is invalid.');
    }
    const issuerMetadata = await requestJson(
      authorizationMetadataUrl(authorizationServer),
      'VibeSpace MCP authorization metadata',
    );
    if (issuerMetadata.issuer !== authorizationServer) {
      throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
    }
    return { mcpUrl: endpoint.toString(), authorizationServer };
  } catch (cause) {
    if (cause instanceof McpConnectionPreflightError) throw cause;
    if (controller.signal.aborted) {
      throw new McpConnectionPreflightError(
        options.signal?.aborted
          ? 'The VibeSpace MCP connection check was cancelled.'
          : 'The VibeSpace MCP connection check timed out.',
      );
    }
    throw new McpConnectionPreflightError('The VibeSpace MCP connection check failed.');
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
```

- [ ] **Step 4: Add failure, timeout, and cancellation tests**

```ts
it('fails closed when protected-resource discovery is invalid', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json({ resource: 'https://other.example/mcp' }));
  await expect(preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher })).rejects.toThrow(
    /discovery metadata/i,
  );
});

it('cancels bounded discovery without starting later requests', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>((_input, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    });
  });
  const pending = preflightVibeSpaceMcp('https://vibespace.example/mcp', {
    fetcher,
    timeoutMs: 50,
  });
  await vi.advanceTimersByTimeAsync(50);
  await expect(pending).rejects.toThrow(/timed out/i);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Run the focused helper tests**

Run: `npm test -- --run src/features/browser-chat/mcpConnection.test.ts`

Expected: PASS with success, malformed metadata, HTTP failure, timeout, and cancellation covered.

- [ ] **Step 6: Commit the helper**

```powershell
git add -- app/src/features/browser-chat/mcpConnection.ts app/src/features/browser-chat/mcpConnection.test.ts
git diff --cached --check
git commit -m "feat(mcp): validate ChatGPT connection discovery"
```

### Task 2: Exact OS-default-browser Plugins handoff

**Files:**

- Modify: `app/src/features/browser-chat/providerSurface.ts`
- Modify: `app/src/features/browser-chat/providerSurface.test.ts`

**Interfaces:**

- Consumes: `CHATGPT_PLUGINS_URL` from `mcpConnection.ts`.
- Produces: `ProviderSurfaceController.openChatGptPlugins(): Promise<void>`.

- [ ] **Step 1: Write the failing exact-handoff test**

```ts
it('opens the exact ChatGPT Plugins page in the OS default browser', async () => {
  const fake = platform();
  const controller = createProviderSurfaceController(fake.implementation);
  await controller.openChatGptPlugins();
  expect(fake.opened).toEqual(['https://chatgpt.com/plugins']);
});
```

- [ ] **Step 2: Run the provider-surface test and confirm it fails**

Run: `npm test -- --run src/features/browser-chat/providerSurface.test.ts`

Expected: FAIL because `openChatGptPlugins` is not defined.

- [ ] **Step 3: Add the exact controller method**

```ts
export interface ProviderSurfaceController {
  openChatGptPlugins(): Promise<void>;
}

// In createProviderSurfaceController:
async openChatGptPlugins() {
  await platform.openExternal(CHATGPT_PLUGINS_URL);
}
```

Expose the same method from the lazy default `browserChatSurface` controller. Do not add a generic arbitrary-URL method.

- [ ] **Step 4: Run provider-surface tests**

Run: `npm test -- --run src/features/browser-chat/providerSurface.test.ts`

Expected: PASS, including existing provider home-page and managed-surface behavior.

- [ ] **Step 5: Commit the exact handoff**

```powershell
git add -- app/src/features/browser-chat/providerSurface.ts app/src/features/browser-chat/providerSurface.test.ts
git diff --cached --check
git commit -m "feat(browser-chat): open ChatGPT Plugins setup"
```

### Task 3: Browser Chat setup progress and recovery

**Files:**

- Modify: `app/src/features/browser-chat/BrowserChatHub.tsx`
- Modify: `app/src/features/browser-chat/BrowserChatHub.test.tsx`
- Modify: `docs/browser-chat/PROVIDER_FEASIBILITY.md`

**Interfaces:**

- Consumes: `preflightVibeSpaceMcp`, `McpConnectionPreflightError`, and `browserChatSurface.openChatGptPlugins`.
- Produces: transient `idle | checking | opening | waiting | error` UI state, a visible endpoint/copy fallback, and a truthful three-step owner checklist.

- [ ] **Step 1: Replace the existing happy-path test with a failing preflight test**

```ts
it('preflights discovery, copies the endpoint, and opens ChatGPT Plugins', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      Response.json({
        resource: 'https://vibespace-mcp.fly.dev/mcp',
        authorization_servers: ['https://auth.example/auth/v1'],
      }),
    )
    .mockResolvedValueOnce(Response.json({ issuer: 'https://auth.example/auth/v1' }));
  const open = vi.spyOn(browserChatSurface, 'openChatGptPlugins').mockResolvedValue();

  render(<BrowserChatHub chatId="chat-1" />);
  fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));

  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(writeText).toHaveBeenCalledWith('https://vibespace-mcp.fly.dev/mcp');
  expect(screen.getByText(/waiting for owner approval/i)).toBeTruthy();
});
```

- [ ] **Step 2: Add failing safety and clipboard fallback tests**

```ts
it('does not copy or navigate when discovery fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));
  await screen.findByText(/connection check failed/i);
  expect(writeText).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('continues the safe handoff when clipboard access fails', async () => {
  writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  fireEvent.click(screen.getByRole('button', { name: /connect vibespace mcp/i }));
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(screen.getByText('https://vibespace-mcp.fly.dev/mcp')).toBeTruthy();
});
```

- [ ] **Step 3: Run the Browser Chat tests and confirm failures**

Run: `npm test -- --run src/features/browser-chat/BrowserChatHub.test.tsx`

Expected: FAIL because the current button skips preflight and opens generic ChatGPT.

- [ ] **Step 4: Implement transient setup state and cancellation**

```ts
type McpSetupState = 'idle' | 'checking' | 'opening' | 'waiting' | 'error';

const [mcpSetupState, setMcpSetupState] = React.useState<McpSetupState>('idle');
const [mcpSetupError, setMcpSetupError] = React.useState('');
const connectionAbortRef = React.useRef<AbortController | null>(null);

React.useEffect(
  () => () => {
    connectionAbortRef.current?.abort();
  },
  [],
);
```

In `connectVibeSpaceMcp`, cancel only a previous preflight, call the helper, copy in a separate non-blocking `try`, open ChatGPT Plugins, and set `waiting`. On preflight or browser failure, show the real bounded error and retain the endpoint. Do not alter relay state.

- [ ] **Step 5: Render truthful progress, endpoint fallback, and checklist**

Render:

```tsx
<Badge variant={relayStatus === 'connected' ? 'success' : 'secondary'}>
  {relayStatus === 'connected'
    ? 'Desktop connected'
    : mcpSetupState === 'checking'
      ? 'Checking secure connection'
      : mcpSetupState === 'opening'
        ? 'Opening ChatGPT Plugins'
        : mcpSetupState === 'waiting'
          ? 'Waiting for owner approval'
          : 'Setup required'}
</Badge>
```

Show the exact endpoint in selectable text plus an explicit copy button. Add the informational checklist:

1. Enable Developer mode.
2. Add VibeSpace MCP.
3. Approve access.

Disable Connect only while checking/opening or when no endpoint exists. Label it Retry after an error. Never mark these owner steps complete based only on browser navigation.

- [ ] **Step 6: Update the feasibility documentation**

Document that VibeSpace now automates preflight, copying, exact Plugins navigation, and relay recovery, while Developer mode, private plugin creation, and OAuth approval remain explicit ChatGPT owner actions.

- [ ] **Step 7: Run focused Browser Chat tests**

Run:

```powershell
npm test -- --run src/features/browser-chat/mcpConnection.test.ts src/features/browser-chat/providerSurface.test.ts src/features/browser-chat/BrowserChatHub.test.tsx src/lib/bridge/useBrowserChatRelay.test.tsx
```

Expected: PASS with no regression to workspace grants, provider surfaces, or relay reconnect.

- [ ] **Step 8: Run boundary verification**

Run:

```powershell
npm run typecheck
npx prettier --check src/features/browser-chat/mcpConnection.ts src/features/browser-chat/mcpConnection.test.ts src/features/browser-chat/providerSurface.ts src/features/browser-chat/providerSurface.test.ts src/features/browser-chat/BrowserChatHub.tsx src/features/browser-chat/BrowserChatHub.test.tsx ..\docs\browser-chat\PROVIDER_FEASIBILITY.md
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 9: Commit and push the completed slice**

```powershell
git add -- app/src/features/browser-chat/mcpConnection.ts app/src/features/browser-chat/mcpConnection.test.ts app/src/features/browser-chat/providerSurface.ts app/src/features/browser-chat/providerSurface.test.ts app/src/features/browser-chat/BrowserChatHub.tsx app/src/features/browser-chat/BrowserChatHub.test.tsx docs/browser-chat/PROVIDER_FEASIBILITY.md
gitleaks git --staged --redact --no-banner
git diff --cached --check
git commit -m "feat(browser-chat): automate VibeSpace MCP setup"
git push origin HEAD
```
