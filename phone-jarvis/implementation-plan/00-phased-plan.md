# phone-jarvis - Phased Build Plan

*From zero to a phone you can call. ~6-8 weeks of focused part-time work. Each phase ends in something demoable.*

---

## Phase 0 - Twilio hello world (2-3 days)

**Goal**: prove you can call a number and hear a recorded message answer.

### Tasks
- Twilio account, free trial, verify your iPhone number.
- Buy a US local number ($1.15/mo). Note: trial accounts can only call verified numbers.
- Stand up the cloud service skeleton:
  - Python 3.11, FastAPI, single `main.py`.
  - One endpoint: `POST /twiml` returning a hardcoded TwiML response with `<Say>` text.
  - Health endpoint at `GET /health`.
- Deploy to Fly.io (`fly launch` + `fly deploy`).
- Set Twilio voice webhook URL to `https://<app>.fly.dev/twiml`.
- Call the number from your iPhone. Hear the message.

### Files to create
- `cloud/main.py`
- `cloud/Dockerfile`
- `cloud/requirements.txt` (just FastAPI + uvicorn)
- `cloud/fly.toml`
- `.env.example` (no secrets needed yet)

### Definition of done
You dial the number; Twilio's text-to-speech says "phone-jarvis hello world."

### Risks
- Trial account number-verification quirks. Workaround: verify the iPhone in the Twilio console.
- Fly.io free machine cold-start delay. Workaround: `min_machines_running = 1`.

---

## Phase 1 - Voice loop MVP (1 week)

**Goal**: real conversation. STT -> LLM -> TTS over Twilio Media Streams via Pipecat.

### Tasks
- Add Pipecat to `requirements.txt`.
- Switch the `/twiml` endpoint to return a `<Connect><Stream url="wss://..." />` directive.
- Implement `WS /twilio/<call_sid>` endpoint that wires Twilio Media Streams into a Pipecat pipeline.
- Pipeline:
  - Twilio transport (Pipecat plugin)
  - Silero VAD
  - Deepgram STT (Nova-3 streaming)
  - LLM service (Anthropic Claude Haiku 3.5)
  - Cartesia TTS (Sonic 2)
- Set system prompt to a basic version of the Sage persona (`prompts/persona.md`).
- Provider keys via Fly secrets: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`.
- Test: call the number; have a 60-second conversation; verify responses.
- Tune barge-in: enable Pipecat's interruption handler.
- Measure latency end-to-end. Target median <800 ms per turn.

### Files to add
- `cloud/pipeline.py` (Pipecat pipeline factory)
- `cloud/prompts/persona.md` (system prompt)
- `cloud/config.py` (env loading)

### Definition of done
You call the number, have a real conversation for 5 minutes, and the AI responds intelligently with median turn latency under 800 ms. No filesystem access yet, just chat.

### Risks
- Pipecat + Twilio Media Stream μ-law decoding edge cases. Mitigation: stick to documented patterns from the Pipecat-Twilio examples.
- Deepgram WebSocket stalls on long silence. Mitigation: Pipecat's connection refresh helper.
- TTS hits a buffer underrun on slow LLM responses (audio gaps). Mitigation: pre-buffer, accept slight latency penalty.

### Won't-do this phase
- No tool calls.
- No PIN.
- No allowlist.
- No audit log (just stdout logs).

---

## Phase 2 - Laptop bridge (1 week)

**Goal**: AI on the phone can read files on your laptop.

### Tasks

**Cloud side**:
- Add `WS /bridge/<token>` endpoint.
- Validate token against `BRIDGE_TOKEN_HASH` env (SHA-256 of the secret).
- Hold the active bridge connection in a process-global registry.
- Add a Pipecat tool dispatcher: when LLM emits `tool_use`, send `tool_call` over the bridge, wait for `tool_result`, fold back into LLM context.
- Tool deadline: 8 seconds. After deadline, return `BRIDGE_TIMEOUT` to LLM.
- Add to LLM system prompt: tool catalog (initially `fs.list`, `fs.read`, `fs.search`, `fs.glob`, `system.time`).

**Laptop side**:
- New `laptop/` folder. Node.js 20 + TypeScript.
- `package.json`, `tsconfig.json`.
- WebSocket client (`ws` package) that dials `wss://<cloud>/bridge/<token>`.
- Tool implementations:
  - `fs.list` (using `fs.promises.readdir` + `stat`)
  - `fs.read` (with path validation, line slicing, byte cap)
  - `fs.search` (shells out to `rg`; falls back to JS scan)
  - `fs.glob` (using `glob` package)
  - `system.time`
- Path validator: realpath + canonical-prefix check against `workspace_root`.
- Deny list: `.env*`, `.aws/**`, `.ssh/**`, `.config/opencode/**`, `*.pem`, `*.key`.
- Reconnect logic with exp-backoff.
- Heartbeat every 15 s.
- Audit log writer to `~/.phone-jarvis/audit/<date>.jsonl`.
- CLI: `phone-jarvis init`, `phone-jarvis start`, `phone-jarvis status`, `phone-jarvis tail`.

**Plumbing**:
- Set `PHONE_JARVIS_BRIDGE_TOKEN_HASH` on Fly.
- Run laptop daemon, verify it connects.

### Files to add
- `laptop/src/index.ts`
- `laptop/src/bridge.ts`
- `laptop/src/tools/*.ts`
- `laptop/src/sandbox.ts`
- `laptop/src/audit.ts`
- `laptop/src/cli.ts`
- `laptop/src/config.ts`
- `laptop/package.json`, `tsconfig.json`
- `cloud/bridge.py` (the WS endpoint + tool dispatcher)

### Definition of done
You call the number; you say "what is in `notes.md`"; the AI says back the contents. You say "search my projects for `TODO`"; you hear back a count and a few examples.

### Risks
- Path-validation bugs leading to escape outside root. Mitigation: aggressive unit tests on the sandbox module before any real call. Add property tests: random paths must never escape.
- WS reconnect storms during flaky network. Mitigation: exp-backoff cap at 5 s, and a 24-hour total deadline.
- LLM emits malformed tool args (wrong types, missing fields). Mitigation: schema validation in the cloud before forwarding; on mismatch, return error to LLM and let it retry.

---

## Phase 3 - Security hardening (3-5 days)

**Goal**: phone-jarvis is safe to actually leave on.

### Tasks
- Allowlist: cloud service reads `allowlist.json` (caller numbers). Unallowed -> hangup TwiML.
- Spoken PIN: greeting prompts for code; cloud verifies; three failures hang up.
- Per-call session ID (correlate cloud and laptop logs).
- Audit log on the cloud side: per-call JSONL with transcript + tool calls.
- Cost cap per call: hard timer at 30 min, hard dollar cap at $5 (estimated from provider mid-call, or just turn count).
- Rate limit per number: max 10 calls / hour.
- `phone-jarvis kill` and `phone-jarvis kill --hard` commands.
- `phone-jarvis ban <number>` and `unban`.
- Documented incident response procedure (one page in `docs/06-security.md`).

### Files to add
- `cloud/auth.py` (allowlist, PIN check)
- `cloud/cost_guard.py`
- `laptop/src/cli.ts` (extend with kill/ban)
- `~/.phone-jarvis/banlist.json` (laptop config)

### Definition of done
- Calling from an unlisted number gets a polite hangup.
- Three wrong PINs hangs you up.
- A 30-min call gets force-ended at the cap.
- Bridge token can be rotated cleanly.

### Risks
- PIN matching against STT output is fragile (homophones, hesitation, "uh" before digits). Mitigation: accept DTMF as a backup ("press your code if it's easier") and use digit-extraction post-processing on the STT.
- Cost estimation mid-call requires per-token tracking. Mitigation: ship a coarse estimator (turns x avg cost per turn); accuracy is fine.

---

## Phase 4 - Polish (1 week)

**Goal**: it feels good to use.

### Tasks
- Persona prompt v2: tune voice, length, tone. Test against 20 sample turns.
- Pre-roll fix: 200 ms delay after Twilio start before greeting (some carriers have dead air).
- Idle hangup: 120 s of user silence -> "you still there?"; another 30 s silence -> hangup.
- AI-initiated hangup: tool `system.hangup()` available to the LLM.
- DTMF shortcuts: `*` ends call, `#` triggers a "summary so far" recap.
- Post-call summary email (optional): cloud uses an SMTP / Resend / Postmark account to email a transcript + tool-call summary after the call ends.
- Status page: `/admin/status?token=...` shows recent calls, latencies, costs.
- Latency telemetry: per-leg histograms, log percentiles.
- Backpressure: if Pipecat queue grows, log a warning; if it stays high, end the call gracefully.
- `notes.append` and `notes.read` tools.
- `fs.summarize` tool (calls a small model on the laptop side).

### Files to touch
- `cloud/prompts/persona.md` (v2)
- `cloud/main.py` (status endpoint)
- `cloud/email.py` (post-call summary)
- `laptop/src/tools/notes.ts`
- `laptop/src/tools/summarize.ts`

### Definition of done
A friend calls you for 10 minutes, hangs up, and the experience felt like talking to a smart assistant. You get an email with the transcript.

### Risks
- Persona over-tuning. Mitigation: keep the persona prompt under 300 words; resist the urge to add rules.
- Email service add-on becomes a dependency. Mitigation: it is optional; default off; uses your existing Resend account.

---

## Phase 5 - Write tools (optional, 1 week)

**Goal**: the AI can also write notes, edit files, and run a small whitelist of shell commands - all behind explicit confirmation.

### Tasks

**Cloud side**:
- Confirm-tier dispatcher: when LLM emits a write-tool call, do NOT forward; instead emit TTS prompt: "you want me to overwrite `notes.md`? say yes to continue." Match user response. Forward only on clean yes.
- Unlock-tier dispatcher: track per-call unlock state; require spoken passphrase ("unlock shell") to enable shell tools.

**Laptop side**:
- New tools (gated):
  - `fs.write` - overwrite a file (full content). Requires confirmed.
  - `fs.edit` - search-and-replace exact substring. Requires confirmed.
  - `fs.delete` - single file only, no recursion. Requires confirmed.
  - `shell.exec` - whitelist of commands (`git status`, `git log`, `npm test`, `pytest`, `ls`, `pwd`, `date`). Requires confirmed AND unlocked.
- Sandbox extensions: write tools must reject if path is outside root (already handled), if path is in deny list (already handled), and if size is > 10 MB.
- Shell sandbox: spawn with restricted env, cwd = workspace root, reject pipes/redirects/`&&`/`;`/backticks/`$()` in args.

### Files to add
- `laptop/src/tools/write.ts`
- `laptop/src/tools/shell.ts`
- `cloud/confirm.py`

### Definition of done
- "Write `# 5 things to do tomorrow` to `notes.md`" -> AI asks "you want me to overwrite `notes.md`? say yes." -> you say yes -> file is written.
- "Run git status in `~/projects/foo`" -> AI says "okay, running `git status`" -> output read aloud.
- `phone-jarvis tail` shows the audit entries with `confirmed: true`.

### Risks
- A "yes" mid-conversation is sometimes a coincidence. Mitigation: confirm dispatcher requires the yes to be the IMMEDIATE NEXT user utterance after the prompt, with no intervening user turn.
- Shell injection via subtle args. Mitigation: argv parsing, no shell, hard rejection of metacharacters.
- Phase 5 is opt-in. If you do not need write access, skip it.

---

## What is explicitly off the roadmap for v1

- **Outbound calls.** AI calling you. Phase 6+.
- **SMS fallback.** Same agent over text. Phase 6+.
- **S2S "just chat" mode.** OpenAI Realtime path. Phase 6+ when cost/latency wins it.
- **Multi-tenant.** Other people running their own instances of your service. Out of v1 by design.
- **Web admin UI.** CLI + audit logs are sufficient for one user.
- **Voice biometric auth.** Phase 7+ if needed.
- **MCP server adoption.** Daemon stays standalone in v1; MCP migration in vNext.
- **Persistent cross-call memory.** v1 is per-call; cross-call memory belongs in the desktop Jarvis project, integrated later.
- **Mobile push.** Same.

## Resource estimate

- **Time**: 6-8 weeks part-time (10 hrs/wk) for solo, faster if you focus.
- **Cost during build**: 
  - Twilio number: $1.15/mo from day one.
  - Provider trial credits cover the build phase.
  - Fly.io: free with `min_machines_running = 1` if you start cold; ~$2/mo for always-on.
- **Cost in operation**: $2-5/mo in providers + $1.15 number = ~$5/mo total for daily personal use.

## Order-of-operations gotchas

- Phase 1 before phase 2. Get the voice loop solid before adding tool calls.
- Phase 3 before phase 5. Security hardening before write tools, always.
- Test phase 0-1 from the iPhone you will actually use, on the actual carrier. Cell-network jitter looks different from WiFi calling.
- Set Fly.io budget alarms before phase 1. Provider keys can leak.
- Buy the Twilio number early. Trial-account verification has its quirks; do it in phase 0, not phase 4.

## After phase 4: shipping

The four-phase MVP (0-3) plus polish (4) is a shippable personal product. At that point:

- Document the install in `README.md`.
- Decide whether to release publicly or keep it personal.
- If public: phase 5 for write tools, phase 6 for outbound + SMS, possibly a managed hosted version for non-technical users (out of personal-tool scope).

This plan is conservative on duration; phases can compress if you focus, blow out if you take detours. The phase boundaries are designed to leave a working, useful tool at each milestone.
