# VibeSpace MCP Worker

The production **VibeSpace MCP** endpoint is a Cloudflare Worker with one
SQLite-backed Durable Object per verified VibeSpace account. It exposes a
standards-based Streamable HTTP MCP resource while local files and tools remain
inside the signed-in desktop app.

## Security boundary

- Supabase project `tipeobvisjqvpbzcpckh` is the only accepted issuer.
- Public MCP requests require a Supabase OAuth token containing `client_id`.
- The desktop exchanges its ordinary Supabase session over HTTPS for a signed,
  one-use, 60-second relay ticket. Its access token is never placed in a
  WebSocket URL.
- The relay accepts only the protocol-v2 `fs.list` and `fs.read` tools under
  the desktop's explicit session workspace grant.
- Absolute roots never leave the desktop. The desktop independently enforces
  path containment, secret filtering, expiry, sequence, replay, and size
  limits.
- Writes, shell commands, browser mutations, and downstream MCP mutations are
  visible in the capability catalog but unavailable until a matching
  VibeSpace approval-session protocol is implemented. The gateway never
  simulates success.
- Provider credentials remain in VibeSpace secure storage and are never copied
  into ChatGPT or Cloudflare.

## Local verification

```powershell
npm install
npm test
npm run typecheck
npx wrangler deploy --dry-run --config wrangler.jsonc
```

The Vitest suite runs in `workerd` and covers OAuth challenges, MCP
initialization, ticket tampering/expiry/replay, Durable Object registration,
account-scoped read routing, capability truthfulness, and mutation denial.

## Deployment inputs

The non-secret `SUPABASE_URL`, `MCP_PUBLIC_URL`, and `ALLOWED_ORIGINS` bindings
are versioned in `wrangler.jsonc`. `RELAY_TICKET_KEY` and the public-but-rotatable
`SUPABASE_PUBLISHABLE_KEY` are stored as encrypted Worker secrets. The relay key
must contain at least 32 random bytes. `/public-config` returns only the
publishable key, only to the allow-listed VibeSpace site origin, so the static
consent page can initialize Supabase Auth without storing any privileged key.

The canonical endpoint is:

```text
https://vibespace-mcp.combatonline02.workers.dev/mcp
```

Supabase OAuth 2.1 and dynamic client registration must be enabled only after
`https://vibespaceos.com/oauth/consent/` is live. ChatGPT then requires one
explicit user consent; later desktop relay reconnections are automatic.
