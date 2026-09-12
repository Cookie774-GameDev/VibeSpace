# VibeSpace OpenCode + Default RLM System Rebuild Plan

**Document type:** Architecture, migration, implementation, and native acceptance contract
**Target:** VibeSpace PR #31 (`agent/pr30-fixes-and-updates`)
**Status:** Implementation-ready plan; not a claim that every item already passes
**Primary objective:** Preserve 100% of VibeSpace Chat’s user-facing capabilities while replacing duplicated, slow, fragile execution plumbing with one persistent OpenCode harness and one VibeSpace-owned, default-on RLM context service
**Quality objective:** Maximum quality without sacrificing responsiveness, correctness, security, exact model identity, or feature coverage
**Release posture:** Keep PR #31 draft. Do not merge, deploy production services, activate billing, or overwrite unrelated owner work as part of this plan.

---

## 0. Executive Decision

The production architecture will be simplified to this:

```text
VibeSpace UI
    ↓
VibeSpace Chat Orchestrator
    ├── mode/access policy
    ├── Prompt Forge when explicitly invoked
    ├── Token Saver / Normal / Token Final Boss
    ├── attachments and active project context
    ├── RLM eligibility — ON by default
    └── selected provider + exact model + exact supported effort
    ↓
VibeSpace OpenCode Harness Client
    ↓
one persistent, VibeSpace-owned `opencode serve` process
    ↓
the exact connected provider/model selected by the user
    ↓
OpenCode SSE events normalized into VibeSpace events
    ↓
VibeSpace UI renders text, reasoning, tools, subagents, usage, files, and status
```

Tools flow through one controlled boundary:

```text
OpenCode model/tool request
    ↓
VibeSpace Tool Gateway
    ├── files
    ├── visible terminals
    ├── Git
    ├── browser/Playwright
    ├── schedules
    ├── skills/plugins/MCP
    ├── app actions
    └── VibeSpace Context / RLM
```

RLM uses this separate path:

```text
OpenCode root session
    ↓
`vibespace_context.query`
    ↓
VibeSpace RLM Coordinator
    ├── Direct
    ├── bounded Retrieval
    └── recursive RLM Investigation
          ↓
      isolated managed RLM worker
          ├── disk-backed ContextProxy
          ├── exact source pointers
          ├── bounded search/open/expand
          └── model callbacks through OpenCode child sessions
    ↓
bounded evidence + exact provenance
    ↓
OpenCode root synthesizes the response
```

### The core rule

**Do not delete working VibeSpace features. Replace only the transport and orchestration layers that are duplicated, slow, or incorrect.**

OpenCode is the only production model harness. VibeSpace remains the product, UI, permission authority, memory/context owner, tool authority, history owner, theme owner, and workflow orchestrator.

---

## 1. Why the Current System Has So Many Problems

The intended user experience is simple:

1. Install or open VibeSpace.
2. VibeSpace automatically gets OpenCode ready.
3. Connect a subscription or API provider once.
4. Select a model.
5. Send a message.
6. See the full response, reasoning, tools, files, and subagents in VibeSpace.

The current implementation became difficult because VibeSpace accumulated too many overlapping layers:

```text
static model catalog
+ subscription CLI catalog
+ OpenCode catalog
+ direct API providers
+ CLI process supervision
+ prompt rewriting
+ context prompt rewriting
+ tool gateway
+ RLM pointer orchestration
+ approval orchestration
+ history/session translation
+ response enforcement
+ UI rendering
```

The main confirmed failure classes are:

### 1.1 A new OpenCode process is started for individual prompts

The existing adapter uses `opencode run --format json --model ...`. That is useful for diagnostics, but it adds process startup, provider initialization, configuration loading, and model discovery to production turns. It also prevents efficient session reuse.

**Fix:** Use a persistent `opencode serve` process and the official TypeScript SDK. Keep `opencode run` only for diagnostics, migration tests, and emergency developer smoke checks.

### 1.2 Provider and model truth is duplicated

PR #31 mixes dynamic OpenCode discovery with static model arrays and a separate Codex CLI catalog. That creates missing models, stale models, invalid model IDs, incorrect plan/region assumptions, and hidden capability differences.

**Fix:** A connection-qualified catalog from the live OpenCode server is authoritative. Static lists become clearly marked offline display fallbacks only and can never silently execute.

### 1.3 VibeSpace rewrites prompts too aggressively

A current RLM failure was traced to VibeSpace replacing a user’s context request before dispatch and discarding mandatory evidence instructions. This is not an OpenCode limitation.

**Fix:** Keep system/security policy separate from the user request. Never rewrite explicit valid tool intent into a different operation. Use structured orchestration instead of fragile natural-language prompt surgery.

### 1.4 RLM has been exposed as low-level choreography

Forcing a model to perform an exact chain such as five searches and six expansions through prompt wording creates brittle behavior. The existing physical RLM test also exposed hybrid pointers and an out-of-range pointer being clamped rather than rejected.

**Fix:** Make `vibespace_context.query` the normal high-level tool. VibeSpace internally performs search, evidence selection, pointer validation, expansion, recursion, and synthesis support. Keep low-level `search/open/expand/address` tools for advanced use and diagnostics.

### 1.5 Reasoning effort is not transported correctly

The existing OpenCode CLI invocation accepts a model but does not reliably carry VibeSpace’s selected reasoning effort. Static adapters also assume a universal set of effort values.

**Fix:** Read model variants from the live OpenCode model metadata for the exact connection and model. `/effort` displays only supported variants. Unsupported selections are disabled or rejected with a clear explanation—never silently downgraded.

### 1.6 Session, process, and context work is repeated

Repeated model discovery, repeated system prompt compilation, repeated context assembly, duplicate history copies, and per-turn processes increase latency and memory.

**Fix:** Persist the server, reuse sessions, cache immutable prompt sections, cache provider/model metadata with explicit invalidation, keep RLM lazy, and store only one authoritative visible history.

---

## 2. Audit Basis and Current Truth

This plan consolidates the prior VibeSpace contracts and current PR #31 evidence, including:

- `VIBESPACE_PR31_OPENCODE_ONLY_HARNESS_GOAL.md`
- `PR31_RLM_INFINITE_CONTEXT_MASTER_GOAL.md`
- `VIBESPACE_PR31_RLM_OPENCODE_NATIVE_E2E_MASTER_GOAL.md`
- `VibeSpace_PR31_Master_Milestones.json`
- current PR #31 OpenCode/provider adapters and model picker code
- the retained native certification ledger

Important current facts:

1. PR #31 already detects OpenCode, probes auth, lists models, invokes OpenCode, and normalizes text/reasoning/tool/usage events. This work must be reused.
2. The OpenCode subscription bridge passed its retained certification twice.
3. The logical 10B+ addressing test passed twice, proving the model → OpenCode → VibeSpace Context → model chain can work.
4. The physical 30M-token RLM corpus exists and was measured at:
   - **312 UTF-8 shards**
   - **159,141,294 bytes**
   - **30,070,856 tokens**
5. The complete physical RLM workflow is not yet fully certified. The most recent evidence still showed:
   - a hybrid/never-issued pointer defect;
   - stale-transition runs not completed;
   - the 30M live runs not completed.
6. The current codebase already contains many VibeSpace features that must remain visible and functionally equivalent.

> **Important terminology correction:** 30 million tokens is not 30 MB. The existing fixture is roughly 159 MB of source bytes for 30.07 million measured tokens. Every large-context test must record both byte size and token count.

---

## 3. Non-Negotiable Product Invariants

The implementation agent must preserve these rules:

1. **OpenCode is the only production harness for native VibeSpace Chat.**
2. **OpenCode is not the VibeSpace UI.** Never expose or embed the OpenCode TUI as the product interface.
3. **VibeSpace remains the outer permission authority.**
4. **VibeSpace remains the source of truth for visible chat history.**
5. **VibeSpace owns Context Maps, RLM storage, All About Me, Jarvis Learning, schedules, terminals, skills, plugins, and app actions.**
6. **The user-selected provider, connection, model, and effort remain exact.**
7. **No silent provider, model, effort, or auth fallback is allowed.**
8. **No provider tokens, cookies, session files, API keys, or OAuth tokens may be scraped or copied into prompts.**
9. **A fresh machine must not require a terminal or manual OpenCode installation.**
10. **A compatible system OpenCode installation must be reused without being modified.**
11. **A system OpenCode installation that is incompatible must be left untouched while VibeSpace uses a managed compatible runtime.**
12. **No visible terminal is created for each chat or response.**
13. **RLM is enabled by default but remains adaptive and lazy.**
14. **RLM ON does not mean every simple message must recursively search.**
15. **Every tool action is scoped to the selected account, workspace, project, worktree, and access profile.**
16. **Browser Chat remains a separate trust domain and is not merged into this native OpenCode harness.**
17. **Existing themes, animations, responsive behavior, accessibility, and voice surfaces remain VibeSpace-owned.**
18. **PR #31 remains draft until its separate release process is satisfied.**

---

## 4. Full Feature-Parity Audit

The following table is a migration contract, not a claim that every row already passes live.

| VibeSpace capability | Current state from source audit | Required result after rebuild |
|---|---|---|
| Streaming chat text | Exists through current providers/bridges | Stream from OpenCode SSE with no full-response buffering |
| Visible reasoning/thinking | Existing normalized events | Preserve model-supported reasoning display and privacy rules |
| Provider/model picker | Exists but mixes static and dynamic catalogs | Fully connection-qualified live OpenCode catalog |
| ChatGPT Plus/Pro | Bridge exists and has passing evidence | Official OpenCode OAuth route; no Codex CLI requirement |
| API-key providers | Native secure key vault exists | Rehydrate credentials into VibeSpace-owned OpenCode runtime without plaintext duplication |
| Local Ollama | Dynamic discovery exists | Preserve offline use and label Chat Only versus Agent Ready truthfully |
| Model Foundry | Existing VibeSpace feature | Keep local artifacts and route viable models through OpenCode |
| Exact model identity | Partial | Selected and observed model must match; otherwise fail closed |
| `/effort` | UI surface exists; transport is incomplete | Dynamic model-specific variants, exact mapping, no unsupported options |
| Prompt Forge | Existing tool-free flow | Preserve exact selected model, no tools, no auto-send, no hidden fallback |
| Token Saver | Existing | Preserve before OpenCode send |
| Normal token mode | Existing | Preserve |
| Token Final Boss | Existing | Preserve; avoid immediate double compaction by OpenCode |
| Attachments/files | Existing | Preserve normalized content, capability checks, and no silent discard |
| Images/media | Existing | Preserve model capability gating and output viewer |
| File read/write tools | Existing action/tool systems | Route through one VibeSpace Tool Gateway and selected access profile |
| Visible terminals | Existing | Preserve IDs, output, history, cwd, scheduling, cancellation, references |
| Git tools | Existing | Preserve; scope to approved repo/worktree |
| Browser/Playwright | Existing | Preserve behind VibeSpace permission boundary |
| Plugins/MCP | Existing pages and state | Expose only connected and allowed capabilities to OpenCode |
| Skills | Existing catalog | Preserve and map to OpenCode skill/instruction/tool integration |
| Schedules | Existing | Preserve conversational and UI scheduling |
| Agents | Existing UI | Preserve UI; use OpenCode primary/child sessions underneath |
| Subagents | Existing workflow requirements | Use OpenCode child sessions, inherit model/access unless explicitly overridden |
| Multitask | Existing | Preserve task UI and parallel child-session tracking |
| Context Maps | Existing | Preserve UI, project binding, 3D visualization, lifecycle |
| RLM | Partially implemented; logical addressing passed | Default ON, adaptive, physical pointer-safe, recursive, cancellable, restart-safe |
| All About Me | Existing guarded store | Preserve; controlled read/update tools only |
| Jarvis Learning | Existing guarded store | Preserve source/confidence semantics |
| Voice input/TTS | VibeSpace-owned | Preserve; voice becomes text into the same OpenCode session and TTS consumes normalized output |
| History/restart | Existing visible history | Stable VibeSpace chat ↔ OpenCode session mapping and safe reconstruction |
| Undo/redo | Existing command surface | Preserve VibeSpace-visible turn and change journal semantics |
| Usage/cost | Existing UI | Show only provider-reported or locally observed values with provenance |
| Offline mode | Existing local route | OpenCode + local provider only; no cloud calls or auth |
| Themes/appearance | Existing | No visual regression; new controls use VibeSpace tokens |
| Browser Chat | Separate architecture | Keep isolated; do not give provider-owned pages native VibeSpace authority |
| `/rlm` | New | Add on/off/status/refresh command and composer control |
| `/performance` | New | Add quality-first performance profile control without changing unsupported model effort |

### Release rule

A feature is not considered preserved because its button still exists. It must pass:

- correct auth;
- correct provider/model;
- correct streaming;
- cancellation;
- restart/resume where applicable;
- permission enforcement;
- secret redaction;
- no silent fallback;
- expected UI behavior.

---

## 5. Target Runtime Topology

### 5.1 Process model

Use this process topology:

```text
VibeSpace desktop process
    ├── React/Tauri UI
    ├── native Tool Gateway
    ├── OpenCode Runtime Supervisor
    │     └── one active `opencode serve` process per active project scope
    │
    └── RLM Supervisor — lazy
          └── isolated RLM run worker only while needed
```

Rules:

- **Never one OpenCode process per message.**
- Reuse one server for every chat in the same active project/worktree.
- Default maximum warm OpenCode servers: **1** on a 16 GB machine.
- Optional maximum: **2** only when measurements show acceptable RAM.
- Idle servers are evicted using an LRU policy after a configurable idle period.
- A chat is an OpenCode session, not a process.
- A subagent is an OpenCode child session, not another full OpenCode installation.
- RLM worker startup is lazy and may stay warm briefly after an RLM run.
- No provider/model process is started until needed.

### 5.2 Security posture of the OpenCode server

Launch `opencode serve` with:

- loopback hostname only: `127.0.0.1`;
- mDNS disabled;
- a random strong per-process server password;
- a VibeSpace-selected unused local port;
- a VibeSpace-owned process handle;
- a VibeSpace-scoped config/data environment;
- no untrusted `--cors` origins;
- bounded logs;
- no secrets in command-line arguments.

The native supervisor must verify:

- executable canonical path;
- executable type;
- version;
- expected OpenAPI capabilities;
- file fingerprint/hash where feasible;
- process identity before every privileged follow-up;
- server health and version through `/global/health`.

### 5.3 SDK transport

Use the official `@opencode-ai/sdk` client against the already-running server.

Production VibeSpace must not shell out to `opencode run` for normal messages.

Required OpenCode API capabilities:

- server health/version;
- providers and connected providers;
- provider auth methods and OAuth;
- model metadata;
- sessions;
- child sessions;
- messages;
- asynchronous prompts;
- commands;
- permission responses;
- session diffs;
- abort/cancellation;
- agents;
- MCP status;
- event SSE.

---

## 6. Automatic Installation, Detection, and Updating

### 6.1 Fresh-machine flow

On first VibeSpace Chat use:

```text
Open Chat
    ↓
Detect system OpenCode
    ↓
Compatible?
  ├─ yes → use binary with a VibeSpace-owned server/config
  └─ no  → check managed runtime
              ↓
           valid?
           ├─ yes → start it
           └─ no  → download, verify, stage, install, start
    ↓
Health + capability check
    ↓
Restore provider connection metadata
    ↓
Show provider connect step only when required
    ↓
Chat ready
```

The user never needs to:

- open PowerShell;
- run `npm install`;
- install Codex CLI;
- edit `opencode.json`;
- choose a harness;
- find a port;
- start a server.

### 6.2 Compatible system OpenCode

If a compatible OpenCode executable already exists:

1. Resolve its canonical path.
2. Reject script shims or replaced executables.
3. Record version and hash.
4. Probe server/OpenAPI compatibility.
5. Launch a VibeSpace-owned headless server using that binary.
6. Apply only VibeSpace-scoped runtime configuration.
7. Do not change the user’s global installation, global permissions, global plugins, or global update channel.

### 6.3 Managed OpenCode runtime

If no compatible runtime exists, install to a versioned VibeSpace app-data path such as:

```text
<VibeSpaceAppData>/runtimes/opencode/<version>/<platform-arch>/
```

Use a VibeSpace compatibility manifest:

```ts
interface HarnessRuntimeManifest {
  schemaVersion: number;
  runtime: "opencode";
  version: string;
  platform: string;
  arch: string;
  downloadUrl: string;
  sha256: string;
  minimumServerCapabilities: string[];
  testedWithVibeSpaceVersion: string;
  releasedAt: string;
  rollbackVersion?: string;
}
```

Required install sequence:

1. Download to staging.
2. Enforce download-size bounds.
3. Verify SHA-256 against a VibeSpace-signed compatibility manifest.
4. Reject archive traversal and unsafe file types.
5. Extract to a staging directory.
6. Probe executable version and OpenAPI capabilities.
7. Start a temporary server.
8. Run health, provider, session, event, and abort smoke checks.
9. Atomically activate the version.
10. Keep the previous known-good runtime for rollback.
11. Clean incomplete staging.

### 6.4 Updating

Do not blindly update a user’s system OpenCode.

For the managed runtime:

- check updates when VibeSpace updates and periodically while idle;
- download in the background only after the compatibility manifest is available;
- do not interrupt a running turn;
- perform canary health checks;
- switch atomically;
- rollback immediately if startup, provider, session, event, or cancellation checks fail;
- show version and last update status in Dev Console;
- support “Check for updates” and “Repair Harness.”

### 6.5 Provider consent is the one unavoidable user step

VibeSpace runtime setup can be automatic. Third-party provider login still requires official user consent:

- ChatGPT Plus/Pro browser OAuth;
- GitHub Copilot device authorization;
- SuperGrok device/browser OAuth;
- API key entry;
- cloud IAM authorization.

After consent, token refresh should be automatic where the provider/OpenCode supports it.

VibeSpace account login and provider authentication remain separate states.

---

## 7. VibeSpace-Scoped OpenCode Configuration

Run the VibeSpace-owned server with isolated configuration overlays.

Use the supported OpenCode configuration environment variables where appropriate:

```text
OPENCODE_CONFIG
OPENCODE_CONFIG_DIR
OPENCODE_CONFIG_CONTENT
```

The generated configuration contains only:

- VibeSpace tool/MCP registration;
- selected project root;
- generated agent profiles;
- permission profile for the current mode/access;
- provider references that do not expose secrets;
- local provider endpoints;
- required model/variant overrides;
- logging limits;
- no hidden fallback model.

Never rewrite the user’s global OpenCode config.

### Secret handling

- API keys remain in the VibeSpace native secure credential vault.
- Inject provider secrets only through a supported in-memory or process environment mechanism.
- Never put secrets in argv, logs, prompts, context records, evidence, or generated config committed to disk.
- OAuth flows use OpenCode’s supported provider auth endpoints.
- Do not scrape cookies, ChatGPT tokens, Codex session files, or browser storage.
- If OpenCode requires scoped token persistence for OAuth, keep it in a VibeSpace-owned, OS-protected data directory and never expose it to the model/tool layer.

---

## 8. Stable VibeSpace Harness Interface

UI and feature code must depend on a VibeSpace interface, not OpenCode response shapes.

```ts
interface VibeSpaceHarness {
  ensureReady(input: HarnessScope): Promise<HarnessReady>;

  listConnections(): Promise<HarnessConnection[]>;
  listModels(connectionId?: string): Promise<HarnessModel[]>;
  refreshModels(connectionId?: string): Promise<HarnessModel[]>;

  createSession(input: CreateHarnessSession): Promise<HarnessSession>;
  getSession(sessionId: string): Promise<HarnessSession | null>;
  listChildSessions(sessionId: string): Promise<HarnessSession[]>;

  send(input: HarnessSendRequest): AsyncIterable<HarnessEvent>;
  cancel(input: HarnessCancelRequest): Promise<void>;

  respondToPermission(input: HarnessPermissionResponse): Promise<void>;
  getSessionDiff(sessionId: string, messageId?: string): Promise<HarnessDiff[]>;

  disposeScope(scope: HarnessScope): Promise<void>;
}
```

Only one production implementation exists:

```text
OpenCodeHarness
```

The old direct-provider and per-prompt CLI paths remain temporarily behind test/developer flags during migration and cannot be automatic fallbacks.

---

## 9. Session, History, and Event Architecture

### 9.1 Stable session mapping

Persist:

```text
VibeSpace chat ID
↔
OpenCode session ID
↔
project/worktree/runtime generation
```

VibeSpace visible history is authoritative.

When reopening a chat:

1. Load visible VibeSpace history.
2. Ensure the correct OpenCode runtime scope is ready.
3. Validate the mapped OpenCode session and runtime generation.
4. Resume if valid.
5. If the OpenCode session is gone, create a replacement and rebuild only the required current state.
6. Never delete or hide visible VibeSpace history because an OpenCode session is missing.

### 9.2 Asynchronous streaming

Use OpenCode’s async prompt endpoint and SSE event stream.

Normalize every OpenCode event into stable VibeSpace events:

```ts
type HarnessEvent =
  | { type: "connected"; runtimeVersion: string }
  | { type: "model_observed"; connectionId: string; modelId: string; variant?: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_proposed"; call: ToolProposal }
  | { type: "tool_started"; callId: string; name: string }
  | { type: "tool_progress"; callId: string; summary: string }
  | { type: "tool_completed"; callId: string; result: SafeToolResult }
  | { type: "permission_requested"; request: PermissionRequest }
  | { type: "child_started"; child: ChildSessionState }
  | { type: "child_progress"; child: ChildSessionState }
  | { type: "child_completed"; child: ChildSessionState }
  | { type: "rlm_route"; route: "direct" | "retrieval" | "rlm"; runId?: string }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "warning"; code: string; message: string }
  | { type: "error"; error: HarnessError }
  | { type: "done"; finishReason?: string };
```

UI components must never parse raw OpenCode JSON or provider-specific JSON.

### 9.3 Cancellation

One cancel action must propagate to:

```text
VibeSpace turn
→ OpenCode root session abort
→ OpenCode child sessions
→ pending Tool Gateway actions
→ context search/open
→ RLM root
→ RLM child model calls
→ RLM sandbox process
```

No late tool or child result may commit into a later turn.

---

## 10. Provider, Authentication, and Model Catalog

### 10.1 Connection-qualified identity

A provider name alone is not enough.

Use:

```ts
interface HarnessConnection {
  id: string;                    // stable, connection-qualified
  providerId: string;
  displayName: string;
  authMode:
    | "subscription-oauth"
    | "api-key"
    | "cloud-iam"
    | "local"
    | "gateway";
  plan?: string;
  region?: string;
  workspaceId?: string;
  endpointClass?: string;
  connected: boolean;
  lastVerifiedAt?: number;
}
```

Examples:

```text
openai-chatgpt-pro
openai-api-personal
github-copilot-pro-plus
xai-supergrok
xai-api
qwen-coding-plan
qwen-paygo-us
qwen-token-plan
zai-coding-plan
zai-api
google-gemini-api
google-vertex-us-central1
ollama-local
```

### 10.2 Dynamic model metadata

```ts
interface HarnessModel {
  connectionId: string;
  providerId: string;
  modelId: string;
  qualifiedId: string;
  displayName: string;

  available: boolean;
  unavailableReason?: string;

  contextWindowTokens?: number;
  maximumOutputTokens?: number;

  modalities: {
    textInput: boolean;
    imageInput: boolean;
    audioInput: boolean;
    textOutput: boolean;
  };

  capabilities: {
    streaming: boolean;
    tools: boolean;
    structuredOutput: boolean;
    vision: boolean;
    files: boolean;
    subagents: boolean;
  };

  variants: HarnessVariant[];
  source: "opencode-live" | "provider-live" | "offline-cache";
  lastVerifiedAt: number;
}
```

The live OpenCode server is authoritative for:

- connected providers;
- models visible to the authenticated account;
- exact provider/model IDs;
- model options and variants;
- tool compatibility where exposed.

### 10.3 No giant hard-coded catalog

Do not “fix” missing models by adding a permanent manual list.

Use:

1. `/provider`
2. `/config/providers`
3. the installed OpenCode OpenAPI types/model metadata
4. provider-specific refresh when required
5. explicit user Refresh Models
6. a short-lived cache

Refresh after:

- provider login/logout;
- API key change;
- plan/region/workspace change;
- OpenCode update;
- app update;
- local model install/remove;
- explicit refresh;
- cache TTL expiration.

Offline cached entries may be shown with:

```text
STALE — LAST VERIFIED <timestamp>
```

They cannot silently execute if the live server no longer exposes them.

### 10.4 Required provider coverage

Every provider currently exposed by VibeSpace must retain parity. The architecture must also allow every provider that the installed OpenCode version exposes to appear without a VibeSpace code release.

Priority release connections:

| Provider route | Authentication | Notes |
|---|---|---|
| OpenAI ChatGPT Plus/Pro | official OpenCode browser OAuth | Subscription route; no Codex CLI requirement |
| OpenAI API | VibeSpace secure API key | Separate connection from subscription |
| GitHub Copilot | device authorization | Model availability is account/plan dependent |
| xAI SuperGrok | official device/browser OAuth | Separate from xAI API |
| xAI API | API key | Dynamic models |
| Anthropic API | API key | Do not use unofficial Claude subscription token plugins |
| Google Gemini API | API key | Dynamic models |
| Google Vertex AI | cloud IAM/service account | Region/project qualified |
| DeepSeek API | API key | Dynamic current model list |
| Z.AI / GLM API | API key | Separate from Coding Plan |
| Z.AI Coding Plan | plan credential | Exact plan model allowlist |
| Alibaba Qwen pay-as-you-go | API key + region/workspace | Dynamic region-aware model list |
| Alibaba Coding Plan | plan-specific key and endpoint | Exact-string allowlist |
| Alibaba Token Plan | plan-specific connection | Different model/tool availability |
| OpenRouter | API key | User-specific model catalog |
| Groq | API key | Dynamic current models |
| Mistral | API key | Dynamic current models |
| Together AI | API key | Dynamic catalog |
| Cerebras | API key | Dynamic catalog |
| Cloudflare AI Gateway / Workers AI | gateway credentials | Connection-qualified |
| OpenCode Zen/Go | supported credential | Dynamic OpenCode catalog |
| GitLab Duo | supported subscription/auth | Dynamic namespace/account models |
| Amazon Bedrock / Azure / other OpenCode providers | provider-supported auth | Appear when configured |
| Ollama | local | Dynamic installed model discovery |
| LM Studio / llama.cpp / custom OpenAI-compatible | local/custom endpoint | Capability probe required |
| VibeSpace Model Foundry | local artifact route | Must prove chat/tool readiness |

### 10.5 Provider acceptance rule

A provider is complete only when:

1. authentication works;
2. the exact live model list is obtained;
3. the exact selected model can be requested;
4. streaming parses correctly;
5. cancellation works;
6. errors are actionable;
7. credentials are absent from logs/prompts;
8. selected and observed model identity match;
9. tool and subagent capability is truthful;
10. no silent fallback occurs.

A model that chats but cannot reliably use tools is labeled:

```text
Chat Only
```

A model is labeled:

```text
Agent Ready
```

only after a structured/tool loop passes.

---

## 11. `/effort` — Exact Model-Specific Variants

### 11.1 Source of truth

Never assume every model supports the same effort settings.

Read variants from the exact live model/connection metadata exposed by the installed OpenCode version. If the installed server does not expose a direct variants field, add a small versioned adapter based on the exact OpenAPI/model configuration for that version.

### 11.2 VibeSpace labels

Use stable product labels:

| VibeSpace label | Upstream variant/meaning |
|---|---|
| Auto | no forced override; model/provider default |
| Minimal | `none` or `minimal`, whichever the exact model exposes |
| Low | `low` |
| Medium | `medium` |
| High | `high` |
| Ultra | `xhigh` |
| Max | `max` |

Do not create `Ultra` or `Max` by sending unsupported values.

### 11.3 Required behavior examples

**GPT-5.6 Sol**

Current official model metadata lists:

```text
none, low, medium, high, xhigh, max
```

Therefore VibeSpace may show:

```text
Auto, Minimal, Low, Medium, High, Ultra, Max
```

for a connection that actually exposes those variants.

**GPT-5.3-Codex-Spark**

Do not assume Spark inherits GPT-5.3-Codex or GPT-5.6 variants. Show only what the live authenticated OpenCode catalog exposes. The expected current product behavior is that unsupported `Ultra` and `Max` options are absent. If upstream later exposes them, the UI updates dynamically without a VibeSpace release.

### 11.4 Failure behavior

If a stale chat stores an unavailable variant:

1. keep the visible historical label;
2. block the new send;
3. explain the variant is no longer available;
4. offer current variants;
5. never silently send the base model/default variant.

### 11.5 Slash command

```text
/effort
/effort auto
/effort minimal
/effort low
/effort medium
/effort high
/effort ultra
/effort max
/effort status
```

Autocomplete must filter choices to the current selected model.

---

## 12. Default-On RLM Context System

### 12.1 User-facing state

RLM is enabled by default for new chats and workspaces.

Resolution order:

```text
chat override
→ workspace override
→ user default = ON
```

Add:

```text
/rlm
/rlm on
/rlm off
/rlm status
/rlm refresh
```

`/rlm` opens a compact VibeSpace control with:

- On/Off;
- current project/context scope;
- index freshness;
- current route: Direct, Retrieval, or RLM;
- last run status;
- Refresh Index;
- Open Trace.

### 12.2 RLM ON means eligible, not always recursive

When RLM is ON:

- simple current-turn questions use Direct mode;
- exact historical lookups use bounded Retrieval;
- large ambiguous cross-source questions use recursive RLM Investigation.

This preserves low latency for normal chat while making large context available automatically.

When RLM is OFF:

- no background project/context search;
- no recursive RLM calls;
- current conversation and explicitly attached files still work;
- the UI clearly indicates context is limited.

### 12.3 Adaptive router

```ts
type ContextRoute = "direct" | "retrieval" | "rlm";

interface ContextRouteDecision {
  route: ContextRoute;
  reasons: string[];
  estimatedScopeBytes: number;
  sourceFamilies: string[];
  confidence?: number;
  budget: RlmBudget;
}
```

Use Direct when:

- the answer is in the current turn;
- the task targets the active file;
- the working set is small;
- no historical or cross-source lookup is needed.

Use Retrieval when:

- a few source files/sessions are likely;
- an exact symbol, fact, revision, or timeline is needed;
- bounded search/open is sufficient.

Use RLM when:

- corpus size greatly exceeds the model window;
- multiple source families are required;
- ambiguity or contradiction is high;
- a broad historical/root-cause question is asked;
- first-stage retrieval confidence is insufficient;
- the user asks about the entire project/archive;
- the acceptance test explicitly requires recursive proof.

The route decision is recorded in the trace but does not clutter normal chat.

---

## 13. RLM Data and Pointer Contract

### 13.1 Raw source authority

Do not copy a 30M-token corpus into:

- React state;
- IndexedDB as repeated full strings;
- every chat message;
- OpenCode prompts;
- the RLM worker’s prompt;
- multiple in-memory buffers.

Raw source bytes remain in their authoritative file/version location.

Use a native metadata/index layer—reuse the existing Context Map store where possible—with:

- account/workspace/project/worktree scope;
- source ID;
- source kind;
- canonical path/reference;
- content hash;
- source version;
- byte length;
- token count;
- indexed spans;
- trust/sensitivity;
- deletion/stale state.

A native SQLite FTS5 or equivalent existing index may hold searchable metadata and bounded spans, but raw files remain authoritative.

### 13.2 Exact pointer

```ts
interface ContextPointer {
  pointerId: string;
  leaseId: string;

  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;

  sourceId: string;
  recordId: string;
  sourceVersion: string;
  contentHash: string;

  byteStart: string;   // decimal string or bigint-safe representation
  byteEnd: string;
  lineStart?: number;
  lineEnd?: number;

  repositoryGeneration: string;
  issuedAt: number;
}
```

### 13.3 Pointer authority rules

A pointer is usable only if:

1. it was actually issued by the current scoped query service;
2. it was included in a visible returned result page;
3. issuance happened after filtering, pagination, and cancellation checks;
4. every tuple field matches one returned row;
5. byte range is within source bounds;
6. source version and hash are still current;
7. lease/account/project/worktree match;
8. repository generation matches or the exact pointer was reissued after restart.

Reject:

- never-issued pointers;
- fields combined from different rows;
- same-file hybrid ranges;
- forged canonical-looking IDs;
- out-of-bounds starts or ends;
- stale versions;
- cross-project pointers;
- cancelled-result pointers;
- hidden continuation rows not returned to the caller.

**Never clamp an invalid range to EOF. Return `pointer_invalid`.**

### 13.4 Large logical addresses

Logical positions above JavaScript’s safe integer range must use:

- decimal strings;
- `BigInt` inside trusted code;
- exact serialization.

Never store 10B/100B addresses as ordinary JavaScript `number` values when precision can be lost.

---

## 14. RLM Runtime and Upstream Integration

### 14.1 Upstream baseline

Use the official `alexzhang13/rlm` implementation as the RLM core rather than silently reimplementing and calling it upstream.

At implementation start:

1. re-audit the current upstream release;
2. pin the exact package version, commit, and artifact hash;
3. record license and notices;
4. add it to SBOM/dependency inventory;
5. document any VibeSpace adapters or patches.

As of this plan, the current published candidate is:

```text
package: rlms
version: 0.1.3
source commit: 72d6940142ddfb84ee6be573dc999a37e633e671
license: MIT
Python: >=3.11
```

Revalidate before implementation; do not automatically float to a newer release.

### 14.2 Do not use the in-process LocalREPL in production

The upstream project explicitly warns that the default in-process local REPL should not be used for production settings.

Use a managed isolated worker:

```text
VibeSpace native RLM supervisor
    ↓ authenticated local RPC
managed Python runtime + pinned rlms
    ↓
restricted low-privilege RLM subprocess
```

Minimum desktop isolation:

- separate process;
- Windows Job Object with kill-on-close;
- restricted user/token where feasible;
- no inherited provider secrets;
- no broad environment inheritance;
- per-run temporary directory;
- no arbitrary project filesystem access;
- outbound network denied except an authenticated loopback model callback;
- hard cell/run timeout;
- memory and process limits;
- explicit import/module allowlist;
- corpus exposed as a safe data proxy, not executable text;
- all child model calls brokered through VibeSpace/OpenCode.

Optional stronger isolation:

- Docker/WSL/container sandbox when installed and explicitly enabled;
- a future dedicated microVM/sandbox provider.

Do not mark production-safe until hostile-corpus and escape tests pass.

### 14.3 ContextProxy

The RLM worker does not receive raw filesystem authority.

Expose a proxy:

```py
class ContextProxy:
    def describe(self) -> ContextDescription: ...
    def search(self, query: str, limit: int = 5) -> list[SearchHit]: ...
    def open(self, pointer: ContextPointer, max_bytes: int) -> EvidenceSpan: ...
    def expand(
        self,
        pointer: ContextPointer,
        before_bytes: int,
        after_bytes: int,
    ) -> EvidenceSpan: ...
    def related(self, pointer: ContextPointer, limit: int = 5) -> list[SearchHit]: ...
```

The proxy communicates with the VibeSpace Context Service over authenticated bounded RPC.

### 14.4 Model callback

The RLM worker never stores provider credentials.

```text
RLM child request
→ VibeSpace model callback
→ OpenCode child session
→ exact selected/inherited connection, model, and effort
→ bounded child response
→ RLM worker
```

Default quality-first policy:

- root model = selected chat model;
- RLM children inherit the same model and effort;
- optional user setting may choose a cheaper/local child model;
- every child route is visible in the trace;
- no child can elevate access beyond the parent;
- no hidden model substitution.

### 14.5 Budgets

```ts
interface RlmBudget {
  maxDepth: number;
  maxSubcalls: number;
  maxConcurrentSubcalls: number;
  maxToolCalls: number;

  maxInputTokensPerChild: number;
  maxOutputTokensPerChild: number;
  maxOpenBytes: number;
  maxTotalEvidenceBytes: number;
  maxWallTimeMs: number;

  maxWorkerMemoryBytes: number;
}
```

Quality-first initial defaults:

```text
maximum depth: 1
experimental depth: 2 only when explicitly enabled
maximum subcalls: 6
maximum concurrent subcalls: 2 on a 16 GB computer
maximum evidence per child: bounded by model/context policy
maximum total opened evidence: 256 KiB default, expandable under explicit budget
hard wall timeout: route- and model-specific
```

All values are configurable and traced. No unbounded recursion or fan-out.

### 14.6 High-level normal tool

Normal OpenCode sessions receive:

```text
vibespace_context.query
```

Input:

```ts
interface ContextQueryInput {
  question: string;
  scope: ContextScope;
  freshness: "current" | "allow-stale-cache";
  preferredRoute?: "auto" | "direct" | "retrieval" | "rlm";
  budgetProfile: "responsive" | "balanced" | "quality";
}
```

Output:

```ts
interface ContextQueryResult {
  route: ContextRoute;
  answerSupport: EvidenceSpan[];
  unresolved: string[];
  traceId: string;
  truncated: boolean;
}
```

Advanced/debug tools remain:

```text
vibespace_context.search
vibespace_context.open
vibespace_context.expand
vibespace_context.address
vibespace_context.trace
```

This removes brittle prompt-mandated operation counts from ordinary use.

---

## 15. Interaction Mode × Access Level × Approve All

Interaction behavior and tool authority are separate controls.

### 15.1 Interaction modes

- **Ask** — one direct user request; no autonomous continuation beyond what the user explicitly requested.
- **Plan** — analysis and planning first; no autonomous product implementation.
- **Agent** — autonomous multi-step completion within the selected access level.

### 15.2 Access levels

- **Read Only** — read, search, RLM, context, web, and non-mutating inspection.
- **Write Access** — Read Only plus create/edit within granted project roots. It is not literal “write without read,” because an agent must read to edit safely.
- **Full Access** — Write Access plus approved terminal, Git, browser automation, MCP actions, rename/move, and delete within granted roots.

### 15.3 Exact 3×3 behavior

| Mode | Read Only | Write Access | Full Access |
|---|---|---|---|
| Ask | Answer and inspect only | Perform only the exact explicitly requested file creation/edit; no autonomous follow-up | Perform only the exact explicitly requested full tool action; no autonomous expansion |
| Plan | Analyze, inspect, and create no files | May create/update plan documents in the granted root; no product implementation | May run inspection commands and create plan artifacts; does not autonomously implement |
| Agent | Autonomous research/analysis with no mutations | Autonomous read/create/edit in granted roots; no shell/delete/browser mutation | Autonomous completion using permitted files, terminal, Git, browser, tools, and subagents |

### 15.4 Approve All

Add a separate visible switch:

```text
Approve All for This Run
```

This must:

- apply only to the current chat/run and selected workspace grant;
- convert eligible `ask` rules to `allow`;
- leave explicit `deny` rules enforced;
- show a clear persistent indicator;
- expire on run completion, chat close, permission change, or explicit disable;
- be stored in the VibeSpace permission state and translated to OpenCode’s permission profile;
- avoid repeated approval cards for matching actions in the granted scope.

The key no-prompt test profile is:

```text
Mode: Agent
Access: Full Access
Approve All for This Run: ON
Workspace grant: disposable test folder only
```

### 15.5 Hard-deny protections that Approve All cannot bypass

Even with Agent + Full Access + Approve All:

- no `.env`, credential vault, browser cookie, OAuth token, private key, or password reads unless separately and explicitly granted;
- no access outside approved roots;
- no OS/system directory mutation;
- no privilege elevation;
- no production database/billing/deployment mutation;
- no destructive delete outside the granted disposable scope;
- no code-signing key access;
- no silent network credential upload;
- no cross-account or cross-project context access;
- no tool permission elevation by a subagent or RLM child.

### 15.6 UI

Show two compact selectors in the composer:

```text
[ Ask | Plan | Agent ]   [ Read Only | Write | Full ]
```

When Approve All is enabled:

```text
[ APPROVE ALL — THIS RUN ]
```

Use a high-visibility amber state for Full Access and an additional active indicator for Approve All. It must remain keyboard accessible and reduced-motion safe.

---

## 16. Subagents and Multitask

Use OpenCode child sessions rather than new OpenCode processes.

### 16.1 Required behavior

- `/subagents` opens the existing VibeSpace subagent UI.
- `/multitask` maps work to tracked child sessions.
- `@agent-name` can invoke a supported subagent.
- child status streams into VibeSpace;
- child output is reviewable;
- children inherit the parent connection, model, effort, RLM setting, and access by default;
- a user may explicitly select another child model when the provider/account exposes it;
- a child cannot receive broader permissions than the parent;
- cancellation cascades;
- concurrency is capped based on memory and provider limits;
- children are reused only where session semantics make sense;
- no hidden process or terminal is opened per child.

### 16.2 Capability truth

Not every model can reliably call tools.

- Tool-capable models may be Agent Ready.
- A model that cannot invoke the Task/subagent tool remains Chat Only.
- The UI must not claim a child was spawned when the provider returned only text.
- A user may be offered a compatible model, but VibeSpace cannot silently switch.

### 16.3 RLM children versus product subagents

Track them separately:

```text
Product child session — visible task/subagent requested by user or main agent
RLM child call — bounded analysis subcall inside one context investigation
```

Both appear in Dev Trace, but RLM child calls need not clutter the normal agent panel unless the user opens details.

---

## 17. Slash Command Contract

Do not forward raw VibeSpace commands to OpenCode and hope OpenCode interprets them.

Use a central command router:

```ts
type CommandOwner =
  | "vibespace-ui"
  | "vibespace-context"
  | "vibespace-tool"
  | "opencode-session";
```

### Existing commands that must remain

| Command | Owner / required behavior |
|---|---|
| `/permissions` | VibeSpace mode, access, Approve All, and effective policy |
| `/ask` | switch to Ask |
| `/plan` | switch to Plan |
| `/agent` | switch/open Agent UI |
| `/multitask` | VibeSpace task orchestration with OpenCode children |
| `/subagents` | child-session UI and control |
| `/terminals` | visible VibeSpace terminal surface |
| `/context` | context/map picker |
| `/plug` | plugin/MCP connection surface |
| `/skills` | VibeSpace skill catalog/attachment |
| `/allaboutme` | guarded profile read/edit/retake/update |
| `/hive` | preserve existing product gate |
| `/file` | safe project file selection |
| `/md` | structured Markdown creation/attachment |
| `/model` | exact connection/model picker |
| `/effort` | exact supported variant picker |
| `/mode` | Token Saver / Normal / Token Final Boss |
| `/attach` | safe absolute-path attachment |
| `/clearfiles` | clear pending attachments |
| `/output` | input/output artifact viewer |
| `/kanban` | existing navigation/workflow |
| `/canvas` | existing VibeSpace canvas behavior |
| `/history` | visible history |
| `/tools` | tools page/status |
| `/agents` | agents page/editor |
| `/schedule` | schedule UI/tool |
| `/chat` | native VibeSpace Chat versus Browser Chat choice |
| `/usage` | truthful usage and freshness |
| `/theme` | agent/chat theme behavior |
| `/themes` | global theme chooser |
| `/appearance` | appearance switch |
| `/undo` | visible full-turn/change undo |
| `/redo` | redo |
| `/commands` | command catalog |
| `/help` | help |

### New commands

#### `/rlm`

```text
/rlm
/rlm on
/rlm off
/rlm status
/rlm refresh
```

#### `/performance`

```text
/performance
/performance responsive
/performance balanced
/performance quality
/performance status
```

Performance profiles affect orchestration—not model identity:

| Profile | Behavior |
|---|---|
| Responsive | direct-route bias, low child concurrency, short evidence budget, same selected model/effort |
| Balanced | default bounded routing |
| Quality | full supported context/RLM budget, quality-first verification, same exact selected model/effort |

**Default for this product goal: `quality`.**

The performance profile may never invent or force an unsupported `/effort` variant.

---

## 18. Prompt Forge, Token Modes, Attachments, and Voice

### 18.1 Prompt Forge

Keep this exact flow:

```text
user draft
→ VibeSpace source pack
→ secret detection
→ exact selected Prompt Forge model
→ OpenCode Harness
→ upgraded prompt
→ preservation validation
→ show editable upgraded prompt
```

Prompt Forge remains:

- tool-free;
- no file edits;
- no shell;
- no subagents;
- no auto-send;
- exact selected model;
- no hidden fallback;
- sensitive-input protected.

### 18.2 Token modes

Keep:

```text
Token Saver
Normal
Token Final Boss
```

VibeSpace token optimization happens before OpenCode send.

OpenCode session compaction may happen only under real context pressure. Detect and surface compaction. Do not immediately summarize away protected content after Token Final Boss.

### 18.3 Attachments

Preserve:

- text files;
- Markdown;
- images;
- selected project files;
- safe absolute-path attachments;
- attachment clearing;
- generated media/artifacts;
- capability checks.

If the selected model cannot accept an attachment type, block before send and explain. Never silently drop it.

### 18.4 Voice

Voice remains VibeSpace-owned:

```text
microphone
→ VibeSpace speech-to-text
→ normal VibeSpace chat turn
→ OpenCode
→ normalized text
→ VibeSpace TTS/Jarvis voice
```

No separate model harness is introduced for voice.

---

## 19. Performance and Efficiency Design

### 19.1 Speed must come from removing overhead, not lowering quality

Do not make the system “fast” by:

- silently lowering effort;
- switching to a cheaper model;
- disabling RLM globally;
- dropping tools;
- removing context;
- truncating user attachments;
- reducing response quality;
- skipping requested verification.

Optimize:

- process reuse;
- connection reuse;
- cached metadata;
- cached immutable prompt sections;
- lazy context;
- bounded tools;
- event rendering;
- child-session reuse;
- route selection.

### 19.2 Critical-path changes

1. Start OpenCode once when Chat is first opened.
2. Keep the SDK client and HTTP connection alive.
3. Use async prompt + SSE.
4. Do not refresh providers/models on every render or turn.
5. Cache model metadata with explicit invalidation.
6. Cache compiled immutable system policy keyed by:
   - VibeSpace version;
   - mode;
   - access level;
   - RLM state;
   - model/variant;
   - project/tool revision.
7. Attach only currently relevant tools.
8. Default RLM ON but run Direct mode for simple turns.
9. Use one high-level context tool for normal chat.
10. Batch tiny UI event updates within a very small frame window without delaying first paint.
11. Keep large tool payloads out of React state.
12. Use bounded ring buffers for logs and terminal output.
13. Avoid duplicate full chat histories in both VibeSpace and OpenCode-facing memory.
14. Lazy-load heavy Context Map visualizations and RLM worker code.
15. Warm the RLM worker only after first use and evict it after idle.

### 19.3 Provisional release budgets

These are targets to measure and freeze, not claims about the current build.

#### Warm request overhead

Compared with a direct SDK request to the same already-running OpenCode server:

```text
VibeSpace-added dispatch overhead:
  median ≤ 150 ms
  p95 ≤ 300 ms

SSE event received → visible UI paint:
  median ≤ 50 ms
  p95 ≤ 100 ms

No new OpenCode process:
  100% of warm chat turns
```

#### Cold readiness

For an already-installed runtime, excluding provider login and model inference:

```text
Chat opened → OpenCode healthy:
  median ≤ 2 seconds
  p95 ≤ 5 seconds
```

#### Memory

Provisional target on a 16 GB Windows machine:

```text
Chat never opened:
  no managed OpenCode process

Chat open, idle:
  OpenCode + bridge incremental RSS target ≤ 300 MB

RLM not used:
  no active RLM sandbox process

RLM worker warm, idle:
  incremental RSS target ≤ 120 MB

RLM source cache:
  default bounded cache ≤ 64 MB

Raw 30M-token corpus:
  not duplicated into memory
```

If current upstream OpenCode alone exceeds a target, record the direct baseline and cap **VibeSpace-added** memory separately.

### 19.4 Honest provider latency

Provider/network latency is not a VibeSpace failure when the same delay appears in the direct OpenCode baseline.

Record:

- direct OpenCode TTFT;
- VibeSpace TTFT;
- difference;
- model output rate;
- queue/retry state;
- VibeSpace CPU/RAM;
- provider status.

---

## 20. VibeSpace Theme and UX

The new system must look native to VibeSpace.

### Composer controls

Use compact themed controls:

```text
[Model] [Effort] [Ask/Plan/Agent] [Read/Write/Full] [RLM On] [Quality]
```

Rules:

- controls wrap cleanly on narrower desktop windows;
- no horizontal clipping;
- keyboard accessible;
- focus ring uses theme tokens;
- reduced-motion supported;
- no OpenCode TUI styling;
- no raw provider IDs unless details are expanded.

### Status language

Examples:

```text
Harness Ready
Connecting OpenAI…
Refreshing models…
RLM On · Direct
RLM On · Retrieval
RLM Investigating · 2 sources · 1 child
Agent · Full Access · Approve All
Model unavailable on this connection
Effort “Max” is not supported by this model
```

### Tool/subagent activity

Keep VibeSpace’s refined activity treatment:

- compact live rows;
- progressive status;
- no flicker;
- no fake completion;
- expandable details;
- cancel visible;
- long outputs virtualized;
- children remain mounted and keyboard reachable.

### RLM trace drawer

Show only on demand:

- route decision;
- source families;
- search count;
- pointers opened;
- bytes opened;
- child calls;
- exact child model/effort;
- wall time;
- cancellation;
- supporting pointers.

Normal users should not see a wall of internal RLM details in ordinary chat.

---

## 21. Proposed Code Organization

Exact filenames may adapt to current repository conventions, but responsibilities must stay separated.

```text
app/src/lib/harness/
├── index.ts
├── contracts.ts
├── OpenCodeHarness.ts
├── OpenCodeClient.ts
├── OpenCodeEventNormalizer.ts
├── HarnessRuntimeStore.ts
├── HarnessReadiness.ts
├── HarnessErrors.ts
├── SessionRegistry.ts
├── ProviderCatalog.ts
├── VariantCatalog.ts
├── CapabilityProbe.ts
├── ScopedConfigBuilder.ts
└── FeatureParityAdapter.ts

app/src/lib/permissions/
├── interactionMode.ts
├── accessProfiles.ts
├── approveAll.ts
├── effectivePolicy.ts
└── permissionTranslation.ts

app/src/features/chat/runtime/
├── ChatOrchestrator.ts
├── ChatCommandRouter.ts
├── RlmCommand.ts
├── PerformanceCommand.ts
├── TurnCompiler.ts
└── TurnTrace.ts

app/src/features/context/rlm/
├── RlmCoordinator.ts
├── RlmRouteDecision.ts
├── RlmBudget.ts
├── RlmTraceStore.ts
├── ContextPointerAuthority.ts
├── ContextLease.ts
└── RlmWorkerClient.ts

app/src-tauri/src/harness/
├── mod.rs
├── detection.rs
├── manifest.rs
├── download.rs
├── verify.rs
├── install.rs
├── process.rs
├── port.rs
├── health.rs
├── secrets.rs
└── paths.rs

app/src-tauri/src/rlm/
├── mod.rs
├── worker.rs
├── sandbox.rs
├── rpc.rs
├── process.rs
└── limits.rs

packages/rlm-worker/
├── pyproject.toml
├── requirements.lock
├── server.py
├── context_proxy.py
├── opencode_callback.py
├── budgets.py
├── trace.py
└── tests/
```

### Reuse before adding

Audit and reuse existing:

- `app/src/lib/ai/adapters/opencode.ts`
- the secure CLI bridge concepts
- `useAccessibleChatModels.ts`
- subscription connection UI/state
- native secure API-key vault
- Prompt Forge executor
- token optimizer bridge
- command typeahead
- current Context Query Service
- current pointer/address implementation
- existing Tool Gateway
- existing action/approval UI
- existing terminal/agent/history UI

Do not introduce parallel duplicates when an existing component can be corrected.

---

## 22. Typed Error Model

```ts
type HarnessErrorCode =
  | "HARNESS_MISSING"
  | "HARNESS_DOWNLOAD_FAILED"
  | "HARNESS_HASH_MISMATCH"
  | "HARNESS_INCOMPATIBLE"
  | "HARNESS_START_FAILED"
  | "HARNESS_HEALTH_FAILED"
  | "HARNESS_CRASHED"
  | "HARNESS_AUTH_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "MODEL_NOT_AVAILABLE"
  | "MODEL_CAPABILITY_MISMATCH"
  | "VARIANT_NOT_AVAILABLE"
  | "LOCAL_MODEL_NOT_INSTALLED"
  | "LOCAL_MODEL_TOOL_UNRELIABLE"
  | "PERMISSION_DENIED"
  | "SESSION_NOT_FOUND"
  | "REQUEST_CANCELLED"
  | "REQUEST_TIMEOUT"
  | "RLM_INDEX_UNAVAILABLE"
  | "RLM_POINTER_INVALID"
  | "RLM_SOURCE_STALE"
  | "RLM_BUDGET_EXHAUSTED"
  | "RLM_SANDBOX_FAILED";
```

Every error includes:

- safe user message;
- repair action;
- diagnostic code;
- retryability;
- affected connection/model;
- no secret;
- no infinite spinner.

---

## 23. Implementation Sequence

The AI implementation agent must work in this order.

### Phase 0 — Protect current work and freeze the baseline

1. Record branch, current head, worktree status, and running app/runtime versions.
2. Preserve all dirty owner work.
3. Coordinate file ownership with the main agent and other workers.
4. Use a separate worktree if concurrent work continues.
5. Inventory the current Chat, Prompt Forge, Token modes, commands, providers, RLM, tools, agents, schedules, terminals, history, usage, voice, and themes.
6. Record current latency/process/RAM baselines.
7. Record the current OpenCode path/version/hash and live OpenAPI capabilities.
8. Record the current upstream RLM pin and package inventory.
9. Do not merge PR #31.

**Exit:** exact baseline and feature matrix recorded.

### Phase 1 — Introduce stable harness contracts

1. Add `VibeSpaceHarness` contracts.
2. Add normalized events and typed errors.
3. Wrap current behavior without switching production routing.
4. Add no-silent-fallback assertions.
5. Keep existing UI unchanged.

**Exit:** current Chat still behaves as before through the adapter.

### Phase 2 — Build the managed OpenCode Runtime Supervisor

1. Implement compatible system-runtime detection.
2. Implement VibeSpace managed runtime manifest/download/install.
3. Implement process ownership, port allocation, password, health, stop, crash recovery.
4. Verify loopback-only and mDNS disabled.
5. Add repair/update/rollback.
6. No visible terminal.

**Exit:** fresh-machine and existing-install scenarios work automatically.

### Phase 3 — Move transport to persistent SDK + SSE

1. Add official SDK dependency.
2. Connect to the owned server.
3. Implement session create/resume.
4. Implement async send and normalized SSE.
5. Implement abort.
6. Implement session diff and permission response.
7. Retain per-prompt CLI path only for diagnostics.

**Exit:** warm turns create zero new OpenCode processes.

### Phase 4 — Replace static provider/model truth

1. Build connection-qualified provider state.
2. Load live providers/models.
3. Add refresh/invalidation.
4. Separate subscription/API/region/plan connections.
5. Remove static lists from production execution.
6. Add exact model observed checks.
7. Add dynamic variants and `/effort`.

**Exit:** a newly exposed upstream model appears without a VibeSpace code change.

### Phase 5 — Implement mode/access/Approve All

1. Add orthogonal 3×3 mode/access state.
2. Translate to VibeSpace Tool Gateway rules.
3. Translate to OpenCode permission rules.
4. Add run-scoped Approve All.
5. Enforce hard denies.
6. Update composer and `/permissions`.

**Exit:** Agent + Full + Approve All performs a scoped test without repeated prompts and cannot escape the scope.

### Phase 6 — Add default-on RLM command and route

1. Add persisted RLM default ON.
2. Add `/rlm`.
3. Add Direct/Retrieval/RLM route decision.
4. Make `vibespace_context.query` the normal tool.
5. Keep low-level operations for diagnostics.
6. Stop destructive prompt replacement.

**Exit:** simple chat has near-zero RLM overhead; broad context questions route automatically.

### Phase 7 — Pin and isolate upstream RLM

1. Re-audit current `rlms` release.
2. Pin exact version/commit/hash.
3. Package managed Python runtime/worker.
4. Implement low-privilege sandbox and authenticated RPC.
5. Add ContextProxy.
6. Add OpenCode model callback.
7. Add hard budgets, cancellation, traces.

**Exit:** a real recursive child call succeeds without provider credentials in the worker.

### Phase 8 — Fix physical pointer authority

1. Issue pointers only for visible completed search results.
2. Bind exact tuple and lease.
3. Reject hybrid/forged/never-issued pointers.
4. Reject out-of-bounds ranges—no clamping.
5. Preserve stale/source-version checks.
6. Preserve 10B+ exact string/BigInt addresses.

**Exit:** existing logical address tests stay green and the hybrid-pointer regression fails closed.

### Phase 9 — Reconnect all VibeSpace features

1. Prompt Forge.
2. Token modes.
3. attachments/images.
4. files.
5. terminals.
6. Git/browser.
7. plugins/MCP/skills.
8. schedules.
9. agents/subagents/multitask.
10. All About Me/Learning.
11. voice.
12. history/undo/redo.
13. usage.
14. themes/appearance.
15. offline local models.
16. Browser Chat isolation.

**Exit:** feature-parity matrix has no missing rows.

### Phase 10 — Performance hardening

1. Remove per-turn process launch from production.
2. Add caches and invalidation.
3. precompile immutable prompt sections.
4. reduce tool schema to active tools.
5. virtualize logs/activity.
6. cap warm servers and children.
7. lazy-start RLM.
8. measure direct OpenCode baseline versus VibeSpace.
9. fix regressions until provisional budgets pass.

**Exit:** warm overhead and RAM budgets pass without lowering quality.

### Phase 11 — Focused implementation checks

Focused unit/component/integration tests are required while building. They do not replace native acceptance.

Do not start the three expensive release tests below until Phases 0–10 are implemented and focused checks are green.

### Phase 12 — Run the three mandatory native tests

Run Tests 1–3 exactly as defined below.

### Phase 13 — Final consolidation

1. Full frontend tests.
2. TypeScript.
3. Rust checks/tests.
4. production build.
5. secret scan.
6. dependency/SBOM.
7. native restart/soak.
8. evidence report.
9. small scoped commits.
10. push to PR #31.
11. keep draft; do not merge.

---

# 24. Mandatory Native Test 1 — Default-On 30M-Token RLM Context

## 24.1 Purpose

Prove that a normal human conversation can retrieve and synthesize exact information from the existing physical 30M-token corpus without stuffing the corpus into the model prompt or telling the model where the answers are.

## 24.2 Required fixture

Use the existing verified corpus if intact:

```text
312 UTF-8 shards
159,141,294 bytes
30,070,856 measured tokens
```

Before the run:

1. Recompute file count.
2. Recompute total bytes.
3. Recompute content hashes.
4. Recompute token count using the frozen tokenizer.
5. Verify Context Map/index registration.
6. Verify private gold answers remain outside the model’s approved scope.
7. Verify RLM default is ON.
8. Use a fresh normal chat.
9. Do not attach the corpus to the prompt.
10. Do not include answer locations in the prompt.

## 24.3 Private evaluator

Create a private evaluator manifest inaccessible to the model:

```json
{
  "questions": [
    {
      "id": "exact-single-source",
      "prompt": "...natural user wording...",
      "expected": "...",
      "requiredSourceIds": ["..."]
    }
  ]
}
```

The model must not see:

- expected answers;
- gold source IDs;
- gold shard names;
- gold byte ranges;
- private evaluator instructions.

## 24.4 Question set

Use five naturally worded questions:

1. **Exact single-source lookup**
2. **Cross-source synthesis**
3. **Current revision versus stale/contradictory decoy**
4. **Numeric or timeline aggregation across multiple records**
5. **Natural follow-up that depends on the prior answer and fresh source validation**

Example style only:

```text
“Hey, can you check our project archive and tell me what the final decision was about <topic>? Please cite where it came from.”
```

Do not say:

```text
“The answer is in shard 42. Use exactly five searches and six expands.”
```

## 24.5 Execution

Run:

```text
Mode: Ask
Access: Read Only
RLM: ON
Performance: Quality
Model: GPT-5.6 Sol
Effort: highest exact supported choice selected for the test
```

Steps:

1. Start a fresh chat.
2. Ask all five questions in natural language.
3. Allow automatic route selection.
4. Require at least one question to justify actual recursive RLM mode with at least one child call.
5. Confirm simple lookup questions may use bounded Retrieval rather than forced recursion.
6. Capture traces.
7. Start a nontrivial sixth investigation, cancel it, and verify full cancellation.
8. Restart VibeSpace.
9. Reopen the chat.
10. Re-ask one question and require current-source evidence.
11. Run a second fresh chat with paraphrased unseen prompts from the private evaluator.

## 24.6 Required trace evidence

For every question:

- selected connection/model/effort;
- route;
- corpus token/byte totals;
- root run ID;
- source families;
- search queries;
- visible search hits;
- exact issued pointers;
- bytes opened;
- source hashes/versions;
- child count;
- child model/effort;
- maximum depth;
- input/output usage where available;
- wall time;
- cancellation state;
- final supporting pointers.

Prove:

```text
root model input << 30,070,856 tokens
```

and:

```text
the full corpus was not duplicated into memory or prompt text
```

## 24.7 Pass criteria

PASS only when:

- first set: **5/5 exact answers**;
- fresh paraphrased set: **5/5 exact answers**;
- at least one real recursive RLM child call is proven;
- exact supporting pointers are valid;
- stale/decoy evidence is rejected;
- no hybrid pointer is accepted;
- no out-of-bounds range is clamped;
- no cross-project source appears;
- cancellation stops root, child, context, and sandbox work;
- restart preserves chat and context registration;
- no entire corpus prompt transfer occurs;
- memory remains within the frozen measured budget;
- no provider/model fallback occurs.

Any wrong answer, forged pointer, stale pointer acceptance, hidden full-corpus load, or leaked evaluator data is a failure.

---

# 25. Mandatory Native Test 2 — Ten-File Read/Write + Math + HTML/TXT/MD

## 25.1 Purpose

Prove that the new mode/access/Approve All system can complete a realistic multi-file task without repeated approval prompts and without escaping the granted folder.

## 25.2 Disposable fixture

Create a disposable folder:

```text
VibeSpace-UAT/read-write-10/
├── source-01.md
├── source-02.md
├── source-03.md
├── source-04.md
├── source-05.md
├── source-06.md
├── source-07.md
├── source-08.md
├── source-09.md
└── source-10.md
```

Each file contains:

- a short source passage or data table;
- one question that must use that source;
- a math/logic component;
- a unique source marker;
- no real private data.

Recommended coverage:

1. linear equation;
2. fractions/LCM;
3. absolute-value inequality;
4. percentage/discount;
5. mean/weighted average;
6. geometry;
7. unit conversion;
8. logic/source inference;
9. table comparison;
10. multi-step word problem.

Keep the private answer key outside the granted folder and outside model context.

## 25.3 Permission setup

Before sending:

```text
Mode: Agent
Access: Full Access
Approve All for This Run: ON
Granted root: only VibeSpace-UAT/read-write-10/
RLM: ON
Performance: Quality
```

The UI must visibly show the three states.

No approval card should interrupt matching actions inside the grant.

Hard-deny protections must remain active.

## 25.4 Natural user prompt

Use:

```text
Please review the ten numbered source files in this folder, answer every question using the information in its file, show the important math clearly, and create three final files: answers.md, summary.txt, and report.html. Make the HTML a clean standalone report, verify all three files after writing them, and do not modify the ten source files.
```

Do not reveal the gold answers.

## 25.5 Required output

### `answers.md`

Must include:

- title;
- one row/section for all 10 source files;
- exact final answer;
- concise reasoning/math;
- source file and line/span reference;
- verification summary.

### `summary.txt`

Must include:

- plain-text list of 10 final answers;
- no Markdown-only formatting;
- UTF-8;
- final newline.

### `report.html`

Must be:

- standalone valid HTML;
- accessible semantic structure;
- responsive;
- no remote dependency required;
- table or cards for all 10 answers;
- source references;
- readable in VibeSpace Preview/browser;
- no script required for core content.

## 25.6 Execution evidence

Capture:

- the exact 10 source file hashes before and after;
- file-read trace proving every source was read;
- tool trace;
- no approval prompts after Approve All activation;
- all create/edit operations;
- terminal commands, if any;
- output file hashes;
- read-back verification;
- HTML parser/preview result;
- no writes outside the granted root;
- no deletion;
- no source-file modification;
- exact model/effort;
- child sessions if used.

## 25.7 Pass criteria

PASS only when:

- all 10 files are read;
- all 10 answers match the private gold key;
- reasoning is mathematically valid;
- `answers.md`, `summary.txt`, and `report.html` exist;
- all three are non-empty and parse/read correctly;
- HTML is standalone, responsive, and accessible;
- all 10 source files retain their original hashes;
- no file outside the grant changes;
- no repeated approval prompt appears;
- Approve All expires after the run;
- exact selected model is preserved;
- no hidden fallback or secret access occurs.

---

# 26. Mandatory Native Test 3 — Qwen Flash vs GPT-5.3-Codex-Spark Speed and Quality

## 26.1 Purpose

Measure and minimize VibeSpace-added latency while preserving model quality, exact model identity, streaming, tools, and all selected options.

## 26.2 Important truth about “average response time”

Do not publish a universal average from marketing pages.

Official current information supports:

- GPT-5.3-Codex-Spark is a ChatGPT Pro research preview designed for real-time coding and can exceed 1,000 output tokens per second on specialized ultra-low-latency hardware.
- Access may queue under high demand.
- Alibaba describes `qwen3.7-flash` as lightweight/low-cost with near-flagship capabilities and a 1M context window.
- Alibaba does not publish one universal end-to-end TTFT/TPS number for the user’s device, region, account, and network.

Therefore the authoritative benchmark is:

```text
same computer
same network window
same OpenCode version
same VibeSpace build
same task
direct OpenCode SDK baseline
versus
VibeSpace through the same OpenCode server
```

## 26.3 Exact model selection

### Qwen

Use:

```text
qwen3.7-flash
```

only if the authenticated live API/Token Plan connection exposes that exact ID.

Alibaba Coding Plan currently uses an exact allowlist and may not include `qwen3.7-flash`. If only Coding Plan is available:

1. record that fact;
2. do not mislabel another model;
3. use the fastest exact Flash-family Qwen model exposed by another authorized API route if the user has one;
4. acceptable alternatives, only when actually returned, include `qwen3.6-flash` or `qwen3.5-flash`;
5. otherwise classify the Qwen Flash slice as an external availability blocker.

### OpenAI

Use the exact live model returned for:

```text
GPT-5.3-Codex-Spark
```

through the OpenAI ChatGPT Pro connection.

Do not substitute GPT-5.3-Codex, GPT-5.6 Luna, or another fast model.

## 26.4 Effort sanity subtest

Before performance runs:

1. Select GPT-5.6 Sol.
2. Open `/effort`.
3. Verify the live connection exposes its exact supported variants.
4. Verify `Ultra` maps to `xhigh` and `Max` maps to `max` when present.
5. Select GPT-5.3-Codex-Spark.
6. Verify only Spark’s live variants appear.
7. Confirm `Ultra`/`Max` are absent unless upstream explicitly exposes them.
8. Attempting a stale unsupported variant must fail before provider send.

## 26.5 Benchmark workloads

Use two workloads.

### Workload A — pure streaming response

- fresh session;
- RLM OFF;
- tools OFF;
- no attachments;
- fixed prompt;
- target 700–900 output tokens;
- same content constraints for both models.

Example:

```text
Explain a production-safe design for a cancellable TypeScript job queue with bounded concurrency. Include the public interface, three failure cases, and one compact implementation example. Keep the answer between 700 and 900 words.
```

### Workload B — realistic coding agent task

Use the same disposable small TypeScript repository for each model.

Prompt:

```text
Fix the failing bounded-concurrency queue tests without changing the public API. Run the focused tests, explain the root cause briefly, and leave the repository passing.
```

Settings:

```text
Mode: Agent
Access: Full Access
Approve All: ON
RLM: ON — adaptive; should remain Direct unless the task genuinely needs project history
Performance: Quality
```

Reset the repository to the same commit before every run.

## 26.6 Run design

For each model and workload:

- 1 cold run;
- 10 warm runs;
- alternate model order;
- use fresh sessions for half;
- use resumed sessions for half;
- do not run the models simultaneously;
- record provider queue/retry state;
- preserve identical VibeSpace feature settings;
- record exact output tokens and tool calls.

Also run the same requests through the direct OpenCode SDK against the same server as the baseline.

## 26.7 Metrics

Record:

```text
runtime cold-start time
send click → SDK dispatch
SDK dispatch → provider accepted
time to first reasoning/text event
time to first visible UI paint
time to first complete sentence
output tokens per second
total model wall time
tool execution time
test execution time
total task wall time
VibeSpace-added overhead
CPU peak
RSS peak
process count
event count
retry/queue count
quality score
```

## 26.8 Quality rubric

### Workload A — 100 points

- technical correctness: 35;
- all requested sections: 20;
- usable code: 20;
- constraint adherence: 15;
- clarity: 10.

### Workload B — 100 points

- focused tests pass: 50;
- no unrelated changes: 15;
- public API preserved: 15;
- root cause accurate: 10;
- clean final state: 10.

## 26.9 Pass criteria

PASS only when:

- exact model IDs are observed;
- no hidden fallback occurs;
- each model averages at least 95/100 quality across accepted runs or all deterministic tests pass with no material rubric failure;
- warm VibeSpace dispatch overhead is:
  - median ≤ 150 ms;
  - p95 ≤ 300 ms;
- SSE-to-visible-paint is:
  - median ≤ 50 ms;
  - p95 ≤ 100 ms;
- zero new OpenCode process is created per warm message;
- no extra terminal window appears;
- VibeSpace does not materially reduce direct OpenCode throughput;
- provider-side queuing is separated from VibeSpace overhead;
- RLM does not activate unnecessarily for Workload B;
- all mode/access/Approve All/model/effort selections remain intact.

Do not fail VibeSpace because Spark or Qwen is temporarily queued when the direct OpenCode baseline is equally queued. Record it as provider-side latency.

---

## 27. Automated Regression Matrix

Add focused tests for:

### Runtime

- compatible system OpenCode;
- incompatible system OpenCode;
- managed runtime;
- missing runtime;
- corrupt download;
- hash mismatch;
- traversal archive;
- replaced executable;
- crash/restart;
- random password;
- loopback-only;
- mDNS disabled;
- health/version mismatch;
- rollback.

### SDK/session/events

- create/resume/reconstruct session;
- async prompt;
- SSE reconnect;
- text/reasoning/tool events;
- child events;
- permission request/response;
- abort;
- no late event after cancel;
- session diff;
- bounded event buffers.

### Catalog

- two connections for the same provider;
- region/plan separation;
- model added without VibeSpace code change;
- model removed;
- stale cache;
- exact observed-model mismatch;
- unsupported effort;
- variant refresh;
- local model added/removed;
- Chat Only versus Agent Ready.

### Permissions

- all nine mode/access combinations;
- Approve All current run;
- expiration;
- explicit deny survives auto approval;
- external directory denied;
- `.env` denied;
- subagent cannot elevate;
- RLM child cannot elevate;
- no cross-account grant reuse.

### RLM

- Direct route;
- Retrieval route;
- recursive RLM route;
- 30M disk-backed proxy;
- no full corpus serialization;
- exact UTF-8 boundaries;
- issued pointer;
- hybrid pointer rejected;
- never-issued pointer rejected;
- stale pointer rejected;
- out-of-range rejected without clamp;
- cancellation;
- restart/reissue;
- BigInt/string address;
- budget exhaustion;
- hostile corpus injection;
- sandbox process termination;
- credential absence.

### Feature parity

- Prompt Forge tool-free;
- all Token modes;
- attachments/images;
- file tools;
- visible terminal routing;
- Git/browser;
- plugins/MCP/skills;
- schedules;
- agents/subagents;
- All About Me/Learning;
- voice;
- history/undo/redo;
- usage;
- themes;
- offline local;
- Browser Chat isolation;
- every slash command.

---

## 28. Migration Without Regression

Use a controlled migration.

Temporary development flags may include:

```text
VITE_OPENCODE_HARNESS_DEV
VITE_OPENCODE_HARNESS_SHADOW
VITE_RLM_COORDINATOR_V2
```

Rules:

- no user-facing harness selector;
- no duplicate paid provider requests in shadow mode;
- compare request assembly without sending twice;
- keep the old route available only for developer rollback until parity;
- migrate feature by feature through the stable harness interface;
- remove old production routing only after the feature matrix passes;
- never reset chats, provider metadata, Context Maps, All About Me, Learning, schedules, agents, or skills during migration.

Rollback:

1. stop the new runtime;
2. restore previous managed runtime pointer;
3. disable the new route flag;
4. preserve visible chats and tool journals;
5. do not delete user provider auth;
6. keep migration diagnostics.

---

## 29. Final Definition of Done

The system is complete only when all are true:

### Automatic setup

- fresh computer requires no terminal;
- compatible system OpenCode is reused;
- incompatible system OpenCode remains untouched;
- managed download verifies and installs automatically;
- update/rollback works;
- provider consent is official and one-time where supported.

### Runtime

- one persistent OpenCode server per active project scope;
- no per-message OpenCode process;
- official SDK;
- SSE streaming;
- cancellation;
- restart recovery;
- bounded memory/logs;
- no public port.

### Models/providers

- dynamic connected catalog;
- every current VibeSpace provider preserved;
- other OpenCode-supported providers can appear dynamically;
- exact connection/model identity;
- exact variants;
- no static execution catalog;
- no silent fallback;
- local Agent Ready probing.

### RLM

- default ON;
- `/rlm` works;
- adaptive Direct/Retrieval/RLM;
- pinned upstream runtime;
- isolated worker;
- disk-backed lazy context;
- exact provenance;
- pointer authority;
- no hybrid/clamp bug;
- cancellation;
- restart;
- 30M native test passes.

### Permissions

- Ask/Plan/Agent;
- Read/Write/Full;
- all nine combinations;
- Agent + Full + Approve All;
- no repeated matching approvals;
- hard denies preserved;
- child permissions bounded.

### Features

- every feature-parity row passes;
- all slash commands pass;
- Prompt Forge and token modes pass;
- attachments/media/voice pass;
- terminals/files/Git/browser/tools pass;
- agents/subagents/schedules/skills pass;
- history/usage/themes/offline pass;
- Browser Chat remains isolated.

### Speed/quality

- no quality reduction;
- no hidden effort reduction;
- warm overhead budget passes;
- RAM/process budget passes;
- Qwen Flash and Spark benchmark is measured honestly;
- direct OpenCode baseline is retained;
- provider queuing is distinguished from VibeSpace overhead.

### Evidence

Final report includes:

1. starting/ending Git head;
2. feature-parity matrix;
3. OpenCode path/version/hash;
4. managed runtime manifest;
5. provider/model/variant snapshots;
6. auth route evidence without secrets;
7. exact model-observed evidence;
8. RLM upstream version/commit/hash/license;
9. RLM architecture and sandbox evidence;
10. 30M corpus manifest;
11. Test 1 results and traces;
12. Test 2 files/hashes/answers;
13. Test 3 raw metrics and quality scores;
14. cancellation/restart proof;
15. memory/CPU/process measurements;
16. automated test results;
17. security/secret scan;
18. files changed;
19. commits pushed;
20. rollback notes;
21. remaining true external blockers.

Use only these verdicts:

```text
VERIFIED
IMPLEMENTED — NATIVE VERIFICATION REQUIRED
IMPLEMENTED — PROVIDER VERIFICATION REQUIRED
BLOCKED — EXTERNAL
NOT COMPLETE
```

---

## 30. Source References

### VibeSpace internal source contracts

- `VIBESPACE_PR31_OPENCODE_ONLY_HARNESS_GOAL.md`
- `PR31_RLM_INFINITE_CONTEXT_MASTER_GOAL.md`
- `VIBESPACE_PR31_RLM_OPENCODE_NATIVE_E2E_MASTER_GOAL.md`
- `VibeSpace_PR31_Master_Milestones.json`
- PR #31 OpenCode, provider, Context, Tool Gateway, Prompt Forge, Token Optimizer, approval, terminal, and session code
- retained PR #31 native certification ledger

### Current official OpenCode references

- OpenCode Server and OpenAPI: https://opencode.ai/docs/server
- OpenCode TypeScript SDK: https://opencode.ai/docs/sdk
- OpenCode models and variants: https://opencode.ai/docs/models
- OpenCode provider authentication: https://opencode.ai/docs/providers
- OpenCode agents/subagents: https://opencode.ai/docs/agents
- OpenCode permissions and auto mode: https://opencode.ai/docs/permissions

### Current official model references

- OpenAI model catalog: https://developers.openai.com/api/docs/models
- GPT-5.6 Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol
- GPT-5.3-Codex: https://developers.openai.com/api/docs/models/gpt-5.3-codex
- GPT-5.3-Codex-Spark announcement: https://openai.com/index/introducing-gpt-5-3-codex-spark/
- Codex rate card: https://help.openai.com/en/articles/20001106-codex-rate-card
- Alibaba Model Studio text models: https://help.aliyun.com/en/model-studio/text-generation-model/
- Alibaba Coding Plan: https://help.aliyun.com/en/model-studio/coding-plan

### Upstream RLM references

- Official repository: https://github.com/alexzhang13/rlm
- Official package: https://pypi.org/project/rlms/
- Official documentation: https://alexzhang13.github.io/rlm/
- Paper: https://arxiv.org/abs/2512.24601

---

## Final Implementation Instruction

Implement this as a **central transport and context simplification**, not as a visual redesign and not as a destructive rewrite.

Preserve existing VibeSpace features, data, chats, providers, tools, themes, animations, and workflows. Make OpenCode persistent, automatic, exact, dynamic, and invisible as infrastructure. Make RLM default-on, lazy, pointer-safe, recursive when justified, and fast for ordinary chat. Make mode, access, and Approve All explicit and scoped. Complete implementation first, then run the three mandatory native release tests, fix every material failure, commit the exact slices, push to PR #31, and keep the pull request draft.
