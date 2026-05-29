# phone-jarvis - Multi-User and Jarvis Integration

*How to make phone-jarvis work for many users inside the Jarvis app. Per-user laptop daemons, shared cloud server, auth, BYO keys, trust model.*

---

## 1. The shape change for multi-user

Single-user phone-jarvis: one cloud node, one laptop daemon, one phone number.

Multi-user phone-jarvis: one cloud node, **N laptop daemons** (one per user, on each user's own machine), zero phone numbers (in-app WebRTC) or N phone numbers (PSTN per user).

The cloud node stays one piece of infrastructure that you operate. Each user installs the Jarvis app and the laptop daemon on their own machine. The daemon dials out to your cloud node with a per-user token. Users authenticate to the cloud node once on signup; from then on the cloud node knows which laptop daemon belongs to which user, and routes their calls accordingly.

```
                                 +------------------+
[user 1's iPhone] <---WebRTC----| Jarvis app | --->|
                                |  "Call Sage"     |
                                +--------+---------+
                                         | WebRTC
                                         v
[user 2's iPhone] <---WebRTC----+--------+---------+
                                |   Cloud node     |
                                |   (LiveKit +     |
                                |    Pipecat,      |
                                |    one Oracle    |
                                |    ARM box)      |
                                +--------+---------+
                                         | per-user
                                         | bridge WS
                                         v
                          +--------------+---------------+
                          |              |               |
              user 1 daemon          user 2 daemon       user N daemon
              (their laptop)         (their laptop)      (their laptop)
              their files            their files         their files
```

Three things make this work:
1. The **cloud node is multi-tenant by user_id**. It has a session table mapping `(user_id, call_id, daemon_socket_id)`.
2. Each **laptop daemon is single-tenant** (one user, one machine). Daemons do not see each other.
3. **Per-user auth tokens** prevent cross-talk. The cloud routes a call's tool-calls only to that user's own daemon.

## 2. Per-user trust model

The trust boundary is the **laptop daemon**, not the cloud node. This is the key safety invariant:

- The cloud node cannot reach into anyone's filesystem. Ever. It can only ask, via a typed JSON message, and only the *user's own daemon* will answer.
- The cloud node CAN see the user's call audio in transit (it is the WebRTC terminator).
- The cloud node CAN see transcripts and tool-call args/results in transit (it forwards them between LLM and daemon).
- The cloud node operator (you) CAN log all of the above.

What this means for users sharing Jarvis:
- They trust you, the cloud operator, with their **call content** (audio, transcripts, what they ask the AI to do).
- They DO NOT trust you with their **filesystem** (you cannot read their files; only their own daemon can).
- They DO NOT trust each other. User A's daemon never sees user B's tool calls.

This is a meaningful trust step up from a typical SaaS where the operator has access to everything. Files never leave the user's machine. **Disclose this clearly in the Jarvis onboarding** so users know what they are agreeing to.

## 3. Auth model

Three layers:

### 3.1 Jarvis app login (user identity)
The user signs into the Jarvis desktop or mobile app. Jarvis already has its own auth in the planned architecture (`projects/Jarvis/docs/02-system-architecture.md`). Plan to use:

- **Better Auth** (open source, self-hostable, free) OR
- **Supabase Auth** (managed, generous free tier - 50,000 MAU)
- **Clerk** (most polished UX, free tier 10,000 MAU)

For phone-jarvis-in-Jarvis, we adopt whatever Jarvis itself uses; no second login.

### 3.2 Daemon -> cloud auth
On Jarvis app first run, the app:
1. Logs the user in.
2. Asks if they want to enable phone-jarvis.
3. If yes, generates a 256-bit `daemon_token` server-side, scoped to `user_id`.
4. Embeds the token into the daemon installer / config the user downloads.
5. Daemon dials `wss://<cloud>/bridge` with the token; cloud verifies and sets the `(user_id, daemon_socket)` mapping in its session table.

Token lifetime: 90 days, renewable by the Jarvis app on next run. Auto-rotated.

### 3.3 Caller -> AI auth (the call itself)
For in-app WebRTC calls (path C): the caller IS the logged-in user. Jarvis app proves identity via session JWT to the cloud. No PIN needed - the act of being signed into Jarvis is the auth.

For PSTN calls (path A or B): the spoken PIN flow stays. Or - the user's phone number is on file from Jarvis signup, so caller-ID can pre-authenticate, with PIN as a fallback.

## 4. The "BYO keys" question

For free-tier providers (Groq, etc.) the rate limit is per-key. For 100 users sharing one Groq key on the free tier, you would hit `30 RPM` immediately during peak.

Two answers:

### 4.1 BYO keys (recommended for the free tier)
Each Jarvis user creates their own free Groq account (30 seconds, no card required) and pastes their key into Jarvis settings. Cloud node uses *that user's* key for *their* calls. Each user gets their own 30 RPM.

Pros: scales to any number of users on the free tier, you do not pay for their usage, users can swap providers per their preference (Anthropic, OpenAI, Groq, local).

Cons: friction in onboarding (one extra step), some users will not bother and will get errors.

Implementation: Jarvis app has a "Provider keys" settings panel; cloud node looks up `user.provider_keys` from the auth backend per-call.

### 4.2 Shared keys with budget cap (operator pays)
You provide one key for everyone, set a hard monthly cap (e.g. $100/mo if you wanted to be generous with paid providers, or just accept the rate limit on free providers).

Pros: zero onboarding friction. Looks magical.

Cons: cost grows with users; rate limits hit hard at scale on free tier; you carry the bag for an abuse case.

**Recommendation: hybrid.** Default to BYO keys ("works forever, free, you own your data"). Provide a "Try it free for the first hour using shared keys" onboarding so users can experience it before configuring. After the free hour, prompt for their key.

## 5. Per-user daemon: what changes from single-user

The single-user daemon design in `04-laptop-bridge.md` is mostly correct. Multi-user changes:

- **Token shape**: instead of one shared bridge token, each daemon has its own per-user token issued by the Jarvis backend. Token is JWT-shaped with `user_id`, `iat`, `exp`, `permissions` claims.
- **Session ID**: the cloud's `(call_id, user_id, daemon_socket)` triple. Tool calls include `user_id` so the daemon can verify the cloud is asking on behalf of the right user.
- **Workspace root**: each user configures their own. Default suggestion: `~/projects` or `~/Documents`. The daemon installer prompts on first run.
- **Per-user audit logs**: stored on each user's own machine, not the cloud. The cloud's audit is just metadata + transcripts.
- **Daemon updates**: handled by the Jarvis app (auto-update). User does not see the daemon as a separate program.

## 6. PSTN for multi-user (path B reality)

If users want a phone number to dial from any phone, not just from the Jarvis app:

Option 1: **One shared DID, AI knows who is calling.** Single phone number. Caller dials, AI greets them, asks "who is this?" or matches caller-ID to a user account, routes the call to that user's daemon. Cheap (one $1/mo number) but only one concurrent call.

Option 2: **Per-user DID.** Each Jarvis user gets their own number, ~$1/mo each. Concurrency unlimited. Cost grows linearly with users.

Option 3: **Skip PSTN entirely. In-app only.** Path C, free, scales free.

For a Jarvis launch, **option 3 first**. Add option 2 as a paid add-on for users who want a real phone number. Skip option 1; concurrent-call limits are confusing.

## 7. Embedding inside the Jarvis app

The Jarvis app gets a "Call Sage" button. Tapping it:

1. Mints a short-lived call JWT from the Jarvis backend (`user_id`, `purpose: phone_call`, `exp: now + 5min`).
2. Opens a WebRTC session to your cloud node via the LiveKit/Daily client SDK, passing the JWT.
3. Cloud node verifies JWT, spins up a Pipecat pipeline for this user, opens a bridge to that user's daemon if connected.
4. Audio flows. UI shows a call screen with a transcript live-updated, hangup button, mute, hold.

The Jarvis app already plans for a voice modal and orb in `Jarvis/docs/05-ui-ux-design.md`. Phone-jarvis fits in as **a different transport for the same voice agent**:
- Desktop voice (already in Jarvis): wake word -> local capture -> send to cloud OR run locally.
- In-app phone call (phone-jarvis path C): "Call Sage" button -> WebRTC capture -> send to cloud, full hands-free.
- PSTN call (phone-jarvis path A or B): no app needed -> caller dials number -> same backend.

The unification: one set of agents, one persona, one memory, three transports.

## 8. UI inside Jarvis

Two new UI surfaces:

### 8.1 Settings panel: "Phone & Voice"
- Toggle: enable phone-jarvis features.
- Workspace root selector (defaults to `~/projects`).
- Provider keys section (Groq, OpenAI, Anthropic, Deepgram, ElevenLabs - paste-in fields).
- Daemon status indicator (connected / disconnected / never installed).
- "Install daemon" button if not installed.
- "Get phone number" upsell (links to PSTN add-on).
- Audit log viewer.
- Call history.

### 8.2 Call modal
- Big "Call Sage" button on the home screen.
- During call: live transcript, mute/hold, hangup.
- After call: summary card with key points, tool calls made, files referenced. Saved to Jarvis memory.

This integrates with the Jarvis to-do system: anything the user commits to verbally during the call gets extracted into the to-do list (per `Jarvis/docs/06-todo-scheduler-notifications.md`).

## 9. Hosting cost as users grow

Oracle Cloud Always Free is one ARM VM with 4 cores and 24 GB RAM. Concurrent calls per machine, in our experience and from public benchmarks:

| Stack | Concurrent calls per box |
|---|---|
| Pipecat + paid providers (provider does heavy lifting) | 50-100 |
| Pipecat + Groq (LLM/STT remote, TTS local Kokoro) | 30-50 |
| Pipecat + all-local (Whisper + Llama via Ollama on same box + Kokoro) | 1-3 (CPU bound) |

Mid-stack (Groq remote + Kokoro local) is the right balance: 30-50 concurrent calls per Oracle ARM machine. For 1000 users with 5% concurrency (50 calls), one Oracle box handles it.

When you outgrow it: spin up more Oracle ARM boxes (free, you can have multiple as long as total never exceeds 4 cores / 24 GB - YMMV per Oracle's quotas), or migrate to a $20-50/mo paid VPS like Hetzner.

The deal-breaker scaling cost is bandwidth. WebRTC audio is ~80 kbps per leg, so 50 concurrent calls = 4 Mbps sustained. Oracle gives 10 TB/mo egress free, which is ~310 GB/day. At 50 concurrent calls running 8 hours/day, you would use about 144 GB/day. Stays under the free egress cap.

## 10. Privacy disclosure for shared Jarvis users

If you are giving phone-jarvis to friends inside Jarvis, surface this clearly in onboarding:

> "When you call Sage, here is what happens:
> - Your voice goes to a server I (the Jarvis operator) run.
> - The transcript of your call goes to the AI provider you configured (Anthropic, OpenAI, Groq, etc.).
> - **Your files NEVER leave your computer.** Sage can read files only by asking your local Jarvis daemon, which runs on your machine.
> - I keep call metadata and transcripts for 30 days for debugging. Anyone can request deletion at any time.
> - Calls are not used to train any model.
> - You can self-host the cloud server too if you do not want to trust me with audio. Instructions in the docs."

This is the level of transparency that earns trust. Skip it and you risk legitimate concerns later.

## 11. Operational responsibilities for the Jarvis operator (you)

Running a multi-user phone-jarvis means you are operating a service. Implications:

- **Uptime.** When your Oracle box restarts, calls fail. Mitigate with: auto-restart on boot (systemd), health checks, status page.
- **Provider quota burnout.** If you provide shared keys, monitor monthly spend. Set hard caps with alerts.
- **Abuse.** Someone might rack up huge LLM bills (paid keys) or DoS the box. Mitigate with: per-user RPM caps, monthly user-budget caps, ban list.
- **Privacy compliance.** Storing transcripts for users in EU triggers GDPR. Either restrict to non-EU users, geo-block, or implement deletion endpoints.
- **Updates.** The cloud node and the daemon both ship updates. Coordinate so old daemons can still talk to new clouds (versioned wire protocol).
- **Support.** Users will hit weird issues. Plan for a support channel (Discord, email, GitHub Discussions).

If this becomes too much, switch the model: open-source the entire stack and require each user to self-host. Then your only responsibility is the code, not running the service. **Recommendation for v1: self-host only**. Ship the Oracle deploy script and let each Jarvis user spin up their own free Oracle box. Multi-tenant on a shared cloud is a phase-2 graduation.

## 12. The phased multi-user rollout

| Phase | Outcome |
|---|---|
| MU-0 | Single-user phone-jarvis works (per `00-phased-plan.md`). |
| MU-1 | Self-hosted-by-user model: ship Oracle deploy script + Jarvis settings panel that lets a user paste their own cloud node URL. Each Jarvis user runs their own cloud node. Zero multi-tenant code. |
| MU-2 | Optional shared cloud node: introduce the per-user auth + session routing in the cloud code. Users can opt into "use the Jarvis hosted cloud" instead of self-hosting. Free tier with rate limits. |
| MU-3 | Provider-key BYO settings UI in Jarvis. Users paste their own Groq/Anthropic/etc keys. |
| MU-4 | PSTN add-on (path A or B) for users who want a phone number. Per-user-DID provisioning flow. |
| MU-5 | Federation: two Jarvis instances can call each other's Sage agents (long-term). |

MU-1 is the simplest "give it to friends" story. They install Jarvis, click a button, get their own free Oracle ARM box deployed in their own Oracle account, and run their own phone-jarvis. You ship code, not a service.

MU-2 is the "managed Jarvis" story. Higher operational burden but better UX.

## 13. The minimum viable multi-user shape

For day-one sharing inside Jarvis, the cleanest viable path:

1. **Cloud node**: you self-host one. Multi-tenant by user_id. Pipecat + LiveKit. Free providers (Groq + Kokoro).
2. **Auth**: piggyback on Jarvis's existing auth (Supabase or Better Auth).
3. **Daemon**: ships with the Jarvis app. User does not see it as separate.
4. **Provider keys**: BYO required. Users paste a Groq key during onboarding. Free for them, free for you.
5. **Transport**: WebRTC only (path C). No PSTN.
6. **Limits**: each user can make calls up to their Groq RPM ceiling. You enforce no extra limits.

Total infra cost for you: $0 (Oracle ARM lifetime free). Total cost for users: $0 (Groq free tier). Operationally manageable up to ~50 concurrent users on one Oracle box.

This is the version you actually ship to friends. Do not start with paid providers, do not start with PSTN, do not start with multi-tenant complexity beyond what is sketched here. Ship something that works and iterate.

## 14. What this looks like for the user

User installs Jarvis, signs up. Goes through onboarding:
> "Want to enable Sage on your phone too?" -> Yes
> "Paste your Groq API key (free, 30 seconds at console.groq.com)" -> [paste]
> "Where on your computer should Sage be allowed to read?" -> [select folder, default ~/projects]
> "Done. Tap Call Sage anywhere in Jarvis to start."

User opens Jarvis on their iPhone. Big purple button: "Call Sage." Taps it. Sage answers. They have a conversation. Sage can see their files (because the laptop is on, daemon is running). They hang up. Total cost to them: $0.

That is the shape you are building toward. Path C, BYO keys, in-app voice. 

## 15. File Locations

- This document: `C:\Users\viper\projects\phone-jarvis\docs\08-multi-user-and-jarvis-integration.md`
- Companion: `docs\07-free-vs-paid-comparison.md`
- Original architecture: `docs\02-architecture.md`
- Security model: `docs\06-security.md`
- Phased build plan: `implementation-plan\00-phased-plan.md`
