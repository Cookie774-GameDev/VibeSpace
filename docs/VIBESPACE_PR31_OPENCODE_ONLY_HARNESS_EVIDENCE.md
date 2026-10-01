# VibeSpace PR31 OpenCode-Only Harness Evidence

Date: 2026-08-11

Branch: `agent/pr30-fixes-and-updates`

Phase 17 starting HEAD: `7b817a79`

Master-goal SHA-256:
`21CE0D454BBB0BF152B78C1904ED9556C92503484D32148372B5BD8032267FAD`

## Verdict

The current PR31 implementation head `b013fe79` is **VERIFIED** for the
credential-free automated and web-runtime scope exercised on 2026-08-11.
Previously reported account-identity and benchmark failures are closed, all
1,093 currently discovered frontend test files pass exactly once, TypeScript
and the production build pass, and both Worker packages pass their applicable
tests, typechecks, and Wrangler dry-runs.

Browser Chat is **IMPLEMENTED — NATIVE VERIFICATION REQUIRED**. Its focused
frontend/bridge suite passes, and a real browser interaction switched a seeded
chat from VibeSpace Chat to Browser Chat and rendered the hub, provider tabs,
connection status, and explicit MCP setup surface. The launched PR31 desktop
process is responsive. Direct automation of the native child WebView remains
blocked because the bundled browser/computer-control runtime cannot initialize
its kernel assets.

Provider-authorized flows are **IMPLEMENTED — PROVIDER VERIFICATION REQUIRED**.
No account credentials, paid-provider calls, custom-app installation, or
provider authorization were used. The current Cloudflare AI News deployment
does not yet advertise `/api/benchmarks`; the app now capability-checks that
route and fails closed on the web instead of issuing a known-broken request or
inventing scores. Deployment remains outside this plan.

The current-head Rust formatting, no-default-feature library check, and
no-default-feature library test suite pass. The library suite ran 361 tests
with no failures; ignored cases are helper processes or the explicitly opt-in
representative corpus benchmark. Existing compiler warnings remain non-fatal.

No merge, push, deploy, release, account mutation, managed-runtime install, or
global OpenCode mutation was performed.

## Phase 18 hardening closure

Starting head: `af404344`

Implementation head before evidence: `b013fe79`

Verified corrections:

- The account-identity test harness now models concurrent Supabase auth
  subscribers instead of replacing the prior listener. Focused result: 35/35.
- Benchmark cards and source links distinguish verified official evidence from
  unavailable independent ranking data; no fallback scores are fabricated.
- Benchmark fetching preflights the deployed Worker capability manifest and
  avoids direct sources in the web runtime when CORS-safe transport is
  unavailable. Focused result: 7 files and 34/34 tests.
- The deterministic full-suite runner discovers every current frontend test
  recursively, partitions each file exactly once, bounds worker concurrency,
  and gives concurrency-heavy tests a 15-second ceiling. Runner result: 1,093
  files passed exactly once; runner unit result: 5/5.
- Browser Chat/MCP post-review audit result: 33 files and 232/232 focused
  frontend tests, plus successful interactive web-runtime engine switching.
- Production build: passed with 4,834 modules transformed.
- Release manifest: 44/44.
- PR31 OSS metadata: passed.
- VibeSpace MCP Worker: 29/29, typecheck, Wrangler dry-run.
- AI News Worker: 16/16, typecheck, Wrangler dry-run.
- Rust: `cargo fmt --all -- --check` passed;
  `cargo check --no-default-features --lib` passed with existing warnings;
  `cargo test --no-default-features --lib` completed 361 tests with no
  failures.
- Credential scanner: 14/14 security contract tests passed.
- Tool Gateway requests are bound to an immutable
  account/workspace/project authority tuple captured before asynchronous
  session creation. Unknown sessions are rejected, scope transitions
  synchronously revoke reads and mutation grants, revoked sessions cannot
  regain access by switching back, stale parent/descendant session trees are
  retired, and authority is revalidated after callbacks immediately before
  provider dispatch. OpenCode adapter result: 17/17 tests; complete harness
  plus adapter result: 17 files and 166/166 tests.
- Mandatory independent final review at `b013fe79`: **READY**, with no P0, P1,
  P2, or P3 findings.
- The unimplemented `context.update` route is no longer advertised or accepted;
  the gateway cannot report a successful context write without persistence.
- `git diff --check` passes for the owned closure paths. The historical reviewed
  range retains non-dispositive whitespace findings in unrelated plan/spec
  files.

The closure evidence was refreshed only after the current-head verification
commands above returned success.

## A. Architecture: VibeSpace to OpenCode to provider/model

The ordinary production path is:

`VibeSpace runAgent` → `dispatchThroughOpenCode(req)` → authenticated,
app-owned loopback OpenCode server → exact reconciled provider/model →
provider API or OpenCode-configured Ollama.

Evidence:

- `app/src/lib/ai/router.ts` has one ordinary
  `dispatchThroughOpenCode(req)` call.
- The ordinary dispatch body does not call a native provider executor,
  external CLI adapter, or legacy `runExternalConnection`.
- External CLI connection identities are rejected for ordinary Chat before
  OpenCode dispatch.
- The only direct CLI transport retained in the router is a private,
  debug-build-only kernel smoke path whose provider, adapter, binding, and
  authentication must match exactly.
- Provider/model selection is reconciled against OpenCode's runtime-discovered
  catalog. Missing providers and models fail explicitly; no first-provider,
  default-model, or silent local fallback is selected.
- User-facing child work maps to OpenCode parent/child sessions. Reparenting is
  rejected and session bindings are account scoped.

Key automated contracts:

- `app/src/lib/ai/openCodeOnlyArchitecture.test.ts`
- `app/src/lib/ai/featureOpenCodeParity.test.ts`
- `app/src/lib/harness/openCodeHarness.test.ts`
- `app/src/lib/harness/providerReconciliation.test.ts`
- `app/src/lib/harness/modelTranslator.test.ts`
- `app/src/lib/harness/childSessions.test.ts`

## B. Runtime installation and startup

| Item                       | Evidence                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum compatible version | `1.18.16`                                                                                                                                           |
| Pinned managed version     | `1.18.16`                                                                                                                                           |
| Asset                      | `opencode-windows-x64.zip`                                                                                                                          |
| Download source            | Exact AnomalyCo GitHub release URL for `v1.18.16`                                                                                                   |
| Compressed bytes           | `60,501,625`                                                                                                                                        |
| SHA-256                    | `a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff`                                                                                  |
| Expanded bound             | `536,870,912` bytes and 128 entries                                                                                                                 |
| Managed root               | Tauri app-local-data + `runtimes/opencode`                                                                                                          |
| Ordinary root observed     | `C:\Users\viper\AppData\Local\ai.jarvis.desktop\runtimes\opencode` absent                                                                           |
| System OpenCode observed   | npm shim `C:\Users\viper\AppData\Roaming\npm\opencode.ps1`, version `1.18.14`; incompatible                                                         |
| Selection policy           | Prefer a compatible trusted system native executable; otherwise use a compatible verified managed executable                                        |
| Startup                    | Ephemeral `127.0.0.1` port, scoped config/data paths, random password, authenticated health check, owned process/job cleanup, bounded crash restart |

The installer verifies exact byte count and SHA-256 while streaming, rejects
unsafe ZIP entries, bounds expanded data and entry count, installs through a
staging directory, atomically publishes the version and active manifest, and
cleans failed/cancelled staging. Runtime registration binds an opaque
executable identity to a canonical path and fingerprint, rejecting
replacement after registration.

## C. Provider evidence

“Discovered models” below means the implementation consumes OpenCode's live
`/config/providers` response dynamically; it does not ship a fabricated
provider model list. “Fixture pass” is automated protocol/config evidence, not
a paid live inference claim.

| Provider       | Supported auth bridge                                        | Models discovered     | Live tested?      | Result           |
| -------------- | ------------------------------------------------------------ | --------------------- | ----------------- | ---------------- |
| OpenAI         | Vaulted API key; official OpenCode OAuth method when exposed | Dynamic               | No credentials    | Fixture pass     |
| Anthropic      | Vaulted API key; Claude Pro/Max is not falsely bridged       | Dynamic               | No credentials    | Fixture pass     |
| Google         | Vaulted API key; official method when exposed                | Dynamic               | No credentials    | Fixture pass     |
| xAI            | Vaulted API key; SuperGrok only when exposed by OpenCode     | Dynamic               | No credentials    | Fixture pass     |
| OpenRouter     | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Groq           | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| DeepSeek       | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Mistral        | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Together       | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Qwen           | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Cohere         | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Perplexity     | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Fireworks      | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Replicate      | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Hyperbolic     | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Novita         | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| Lambda         | Vaulted API key                                              | Dynamic               | No credentials    | Fixture pass     |
| GitHub Copilot | Official OpenCode OAuth method only when exposed             | Dynamic               | No account flow   | Fixture pass     |
| Ollama         | Local loopback OpenAI-compatible config; no cloud secret     | Installed models only | Availability only | Config/unit pass |

Additional runtime aliases are reconciled only when OpenCode actually exposes
them, including Azure, Amazon Bedrock, Hugging Face, Cerebras, Z.AI, Google
Vertex, and explicit custom providers. VibeSpace does not invent connectivity
for those aliases.

Credential values are loaded from the VibeSpace account-scoped vault into
per-process environment variables. They are not serialized into generated
OpenCode config, logs, status responses, or this report. Key add/update/delete
rotates the app-owned server so stale credentials are not retained.

## D. Local model evidence

Ollama `0.21.0` was present. Read-only `ollama list` reported:

| Model                                | Installed?                       | Chat                                          | Tools           | Context         | Agent ready?      |
| ------------------------------------ | -------------------------------- | --------------------------------------------- | --------------- | --------------- | ----------------- |
| `llama3.2:latest`                    | Yes, 2.0 GB                      | Not live-tested through VibeSpace in Phase 17 | Not live-tested | Not live-tested | Not claimed       |
| `qwen2.5:1.5b-instruct-q4_K_M`       | Yes, 986 MB                      | Not live-tested through VibeSpace in Phase 17 | Not live-tested | Not live-tested | Not claimed       |
| GPT-OSS                              | Not observed                     | Not tested                                    | Not tested      | Not tested      | No evidence       |
| Dynamically installed unlisted model | None newly installed in Phase 17 | Fixture-tested                                | Fixture-tested  | Fixture-tested  | Fixture pass only |

Direct loopback probes against both installed models verified an exact chat
reply, multi-turn nonce recall (`COBALT-7319`), and a structured
`lookup_status(service="vibespace")` tool call. These probes exercised Ollama
directly and are not evidence of the still-blocked VibeSpace desktop/OpenCode
end-to-end path.

Automated native tests prove generated Ollama config contains every valid
installed model and no catalog phantoms, uses
`http://127.0.0.1:11434/v1`, omits the provider when Ollama is missing, and
regenerates when models change. Selection of a removed local model fails
explicitly rather than falling back.

## E. Feature parity

| Surface                                        | Evidence status                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Prompt Forge / Prompt Upgrade                  | Automated pass; runs through OpenCode and denies tools                                                                       |
| Token modes / optimizer                        | Automated pass; exact verified provider/model variants preserved                                                             |
| Normal chat / streaming / cancellation / usage | Automated pass through OpenCode client and SSE normalization                                                                 |
| Attachments / working directory                | Automated pass                                                                                                               |
| Slash commands                                 | Automated Section 20 execution matrix pass; aliases share canonical behavior                                                 |
| Context / semantic search                      | Automated pass through narrow semantic gateway                                                                               |
| Files                                          | Read-only semantic access is rooted and verified; semantic file write is not exposed, and OpenCode edit/write remains denied |
| Memory / All About Me                          | Automated account-scoped parity pass                                                                                         |
| AAM / Jarvis Learning                          | Automated parity pass                                                                                                        |
| Plugins / MCP                                  | Registered read-only, never-approval plugin reads bridged; generic plugin writes remain forbidden                            |
| Skills                                         | Automated account-scoped parity pass                                                                                         |
| Terminals                                      | Semantic terminal actions and approval routing pass; no generic native invoke                                                |
| Model Foundry                                  | Automated local artifact/inference/training parity pass                                                                      |
| Subagents / multitask                          | OpenCode child-session binding and activity tracking pass                                                                    |
| Approval UX                                    | Native gateway requests are presented through existing VibeSpace approval flow                                               |

This table is an automated parity result. The Files row records the verified
read-only boundary, not file-write parity. Manual desktop execution is not
claimed because UI automation did not initialize.

## F. Phase 17 historical verification results

This section preserves the exact pre-hardening Phase 17 baseline. It is
superseded by the Phase 18 closure results above.

### Frontend

- Monolithic `npm test -- --run`: timed out after approximately 603 seconds
  without a final summary. No pass is claimed from that run.
- Sharded `src/lib`: 255 files, 3,795 tests passed.
- Sharded `src/features`: 788 files, 6,041 passed and 4 failed.
- Remaining `src` tests: 51 files, 330 passed and 12 failed.
- Aggregate sharded result: 1,094 files; 1,092 files passed and 2 failed;
  10,166 tests passed and 16 failed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite transformed 4,833 modules. Existing dynamic
  import and large-chunk warnings remain warnings.

Failing files:

- `src/features/benchmarks/BenchmarksPage.warmSchemaB.test.tsx`: 4 failed,
  1 passed. The component no longer supplies the expected fixture text such as
  `from snapshot`; related benchmark source/tests were already dirty and
  excluded from PR31 ownership.
- `src/App.accountIdentity.test.tsx`: 12 failed, 23 passed, reproduced in
  isolation. Failures include missing cloud-sync retry/start calls, authority
  quiescence ordering, and a `pro` tier where `free` was expected.

Focused phase checkpoints also passed before the final sharding:

- Phase 15 feature parity: 25 files, 354 tests, including all 90 harness
  runtime tests.
- Phase 16 OpenCode-only routes: 16 files, 248 tests, including all 90
  harness runtime tests.

### Native and supply chain

- `cargo test --no-default-features --lib`: 353 passed, 0 failed, 8 ignored.
  Ignored cases are helper processes or an explicitly opt-in representative
  corpus benchmark.
- `cargo fmt --check`: passed.
- `cargo check --no-default-features --lib`: passed with existing warnings.
- `npm run verify:pr31-oss`: passed.
- `node --test scripts/pr31-oss-bundle.test.mjs`: 2 passed, 0 failed.

The native suite includes runtime detection/fingerprinting, verified download
and extraction, atomic installation, authenticated loopback lifecycle,
provider credential regeneration, dynamic Ollama config, semantic gateway
authorization, bounded request/response handling, process ownership, crash
budget, and cleanup tests.

### Desktop/manual

- The VibeSpace development process was observed running from this worktree.
- Computer Use initialization failed before any UI action:
  `failed to write kernel assets: The system cannot find the path specified.
(os error 3)`.
- Therefore no Phase 17 manual chat/provider/local-model matrix is marked
  passed.

## G. Current blockers and residual risk

1. Repair the bundled browser/computer-control kernel-assets installation and
   complete the native child-WebView interaction matrix.
2. With explicit account authorization, verify only the provider/subscription
   flows intended for release. Until then, those flows retain
   `IMPLEMENTED — PROVIDER VERIFICATION REQUIRED`.
3. Deploy the already-tested AI News Worker change in a separately authorized
   deployment task before claiming the Cloudflare benchmark snapshot route is
   live. The current app behavior remains truthful while it is absent.
4. Install the pinned managed OpenCode `1.18.16` through the VibeSpace UI, or
   install a compatible trusted native runtime, before live OpenCode/provider
   dispatch verification.

## H. Security evidence

- No secret values were printed or written to config/evidence.
- OpenCode binds only to `127.0.0.1` on an ephemeral port.
- Client/server health and API calls require exact Basic authentication.
- The semantic Tool Gateway has its own exact Bearer token and fixed catalog.
- Generated tools cannot call `tauri.invoke`, `native.invoke`, arbitrary
  commands, or a generic plugin mutation route.
- High-risk writes flow through existing approval policy; unattended
  read-only plugin bridging is limited to registrations whose declared risk is
  `read-only` and approval is `never`.
- Managed runtime bytes are pinned by version, size, source, and SHA-256.
- Archive traversal, symlink/reparse ambiguity, oversized extraction,
  duplicate paths, alternate streams, incomplete downloads, and hash mismatch
  fail closed.
- Runtime executable identity is canonicalized, fingerprinted, and rechecked
  before use.
- Scoped OpenCode config/data directories are app-owned; the user's global
  OpenCode configuration was not read for secrets or modified.
- Server lifecycle is single-flight and process-owned; stop/crash cleanup does
  not target unrelated OpenCode PIDs.
- Account-scoped provider/plugin/skill/session authorities reject cross-account
  reuse.

## Phase history

PR31 was delivered in sequential locked phases covering runtime contract,
detection, verified install, authenticated server lifecycle, typed client/SSE,
provider/model reconciliation, API-key vault bridge, official subscription
bridge, Ollama, the `runAgent` switch, semantic tools/permissions, slash
commands, Prompt Forge/token modes, child sessions, remaining feature parity,
and legacy route removal. Phase 17 adds this final evidence and does not alter
product code.
