# Jarvis - Multi-Agent Orchestration Design

*Companion to `02-system-architecture.md`. This is the design of the agent runtime itself.*

---

## 1. The orchestration layers

Jarvis runs four conceptual layers, top to bottom:

1. **Jarvis (the voice + intent supervisor).** The user-facing assistant. Owns voice in/out, intent classification, and routing to the orchestration layer. Always the first responder.
2. **Council orchestrator (Mastra-based).** Decides whether a request needs one agent or many. Spins up a supervisor + workers graph for multi-agent tasks. Owns shared state.
3. **Worker agents.** Specialists pulled from a registry. Each has a persona, system prompt, model config, allowed tools, and memory scope. Workers can be parallel, sequential, or hand-off-routed depending on the task.
4. **Tool & memory layer.** MCP servers, native tools, vector store, SQLite metadata, sandboxes.

Every user request travels top-down. Every result aggregates bottom-up.

## 2. Agent topology

We default to **supervisor + specialist workers** because Anthropic's data shows it outperforms single-agent by ~90% on research-shaped tasks, and it's the most teachable pattern to end users (they understand "manager + team" intuitively).

```
                    +--------------------+
                    |       USER         |
                    +---------+----------+
                              |
                              v
                    +--------------------+
                    |  JARVIS (voice/    |
                    |  intent supervisor)|
                    +---------+----------+
                              |
                              v
                    +--------------------+
                    |  COUNCIL           |
                    |  ORCHESTRATOR      |
                    | (Mastra graph)     |
                    +----+--------+---+--+
                         |        |   |
              +----------+        |   +----------+
              v                   v              v
     +-----------------+ +-----------------+ +-----------------+
     | Research worker | | Coder worker    | | Writer worker   |
     | (Sonnet)        | | (Sonnet+coding) | | (Opus)          |
     +-------+---------+ +--------+--------+ +--------+--------+
             |                    |                   |
             v                    v                   v
     +------------------ MCP tools + memory ------------------+
     |  filesystem, shell, git, web, calendar, mail, ...      |
     +---------------------------------------------------------+
```

Other patterns are available as workflow templates but not defaults:

- **Sequential pipeline.** Predictable flows: extract -> analyze -> summarize.
- **Parallel fan-out.** Independent subtasks run concurrently; results joined. Good for research breadth.
- **Hierarchical teams.** Supervisors of supervisors when scope is large.
- **Swarm / handoff.** Agents pass control fully via OpenAI Agents SDK style handoffs. Useful for "talk to sales then engineering" flows.
- **Council mode (UX-only).** Multiple agents respond to the same prompt in parallel for the user to compare or synthesize. This is the visible UI mode, but underneath it's a parallel fan-out with no supervisor.

## 3. The Council orchestrator (Mastra layer)

### Inputs
- User message (text or transcribed voice).
- Active project context (system prompts, allowed tools, memory namespace).
- Recent conversation history (windowed + summarized).
- Current to-do list state (so agents can reason about pending tasks).

### Decisions made
1. **Single-agent or multi-agent?** A small classifier (Haiku-class) decides based on intent. Defaults to single-agent unless evidence of breadth/parallelism.
2. **Topology.** If multi-agent, pick supervisor + workers vs parallel fan-out vs sequential.
3. **Worker selection.** Pick from the worker registry based on capability tags ("research", "code", "design", "math", "voice"). Supervisor can override.
4. **Tool budget.** Per-agent tool allowlist + per-task token cap from the cost meter.
5. **Sandbox policy.** Workers that touch the filesystem or run code get a sandbox.

### Output
A Mastra workflow graph instance. Streams tokens, tool calls, and state updates to the UI in real time via the Vercel AI SDK UI Message Stream protocol.

## 4. The agent registry

Each agent is a JSON definition + optional skill bundle:

```json
{
  "id": "researcher",
  "name": "Research Worker",
  "description": "Reads docs, browses, synthesizes findings.",
  "model": "claude-sonnet-4",
  "system_prompt_path": "prompts/researcher.md",
  "tools_allowed": ["web_search", "browser_fetch", "memory_read", "memory_write"],
  "memory_scope": "project",
  "max_tokens": 64000,
  "max_concurrent": 4,
  "color_hue": 195,
  "capabilities": ["research", "summarization"]
}
```

Default agents shipped with the app:
- **Jarvis** (the voice supervisor; persona-rich, calm)
- **Researcher** (Claude Sonnet 4)
- **Coder** (Claude Sonnet 4 with coding system prompt + extended tool access)
- **Writer** (Claude Opus 4)
- **Analyst** (GPT-5 with code interpreter + math)
- **Critic** (GPT-5-mini, cheap; runs as last-step reviewer)
- **Memory keeper** (always-on; extracts and stores facts from every chat)
- **Action extractor** (always-on; surfaces draft to-dos from chats and meetings)

Users can clone any agent into a custom version, change the model, prompt, or tools, and save to their workspace.

## 5. Inter-agent communication

Three mechanisms, used at different scales:

### 5.1 Shared workflow state (default)
All agents in a workflow read/write a typed state object. Mastra handles the schema, persistence, and concurrent updates. Use for tightly-coupled subtasks within one user request.

### 5.2 Structured messaging (the BridgeMind gap)
When agents genuinely need to talk to each other (Reviewer asks Builder for clarification), they exchange typed messages on a bounded channel:

```typescript
type AgentMessage = {
  from: AgentId;
  to: AgentId | 'broadcast';
  channel: 'question' | 'clarification' | 'review' | 'handoff';
  body: string;
  context_refs: ContextRef[];
  token_budget: number; // hard cap on response
}
```

The orchestrator throttles message volume per task (default: 8 messages between any pair before forced escalation to human) so agents can't loop infinitely. This is what BridgeMind explicitly disallowed and what we differentiate on.

### 5.3 A2A (Agent2Agent protocol) for external agents
When the user installs a remote agent (e.g., a corporate compliance agent at https://corp.com/a2a), we expose it as a worker via Google's A2A protocol. The orchestrator treats it like any other worker but with network latency budgeted in.

## 6. Memory access patterns

Agents read and write memory through the **memory router**, never directly to the vector store.

### Read
- **Auto-retrieve.** Before each agent step, the router runs a hybrid search (semantic + keyword + recency) on the agent's memory scope and injects top-K chunks into the system prompt.
- **Tool-call retrieve.** Agents can also explicitly call `memory_read({ query, scope, k })`.

### Write
- **Auto-extract.** After each chat turn, a Memory Keeper agent runs in the background, extracts atomic facts ("user prefers Tailwind", "Alex's email is alex@acme.com"), and writes them to memory.
- **Tool-call write.** Agents can call `memory_write({ content, source_ref, tags })` for explicit pinning.
- **Decay.** Memory items get a confidence score that decays over time; recent reinforcements bump it back up.

### Scope
Every memory item is tagged with `workspace_id`, `project_id`, `agent_id` (optional), and `session_id`. Agents see the union of:
- their own scoped memories,
- project-shared memories,
- workspace-shared memories.

User memories (preferences, facts about the user) are workspace-shared. Project-specific facts (codebase decisions, meeting notes) stay in the project.

## 7. Tool calling

Tools are exposed via MCP. The orchestrator builds a per-agent tool list at workflow start by intersecting:
- the agent's `tools_allowed`,
- the user's installed MCP servers,
- the project's tool allowlist (if any),
- the user's per-tool approval policy (always / per-session / per-call / never).

### Approval gates
Destructive or expensive tools get gated by default:

| Tool family | Default policy |
|---|---|
| `memory_*` | always-allow |
| `web_search`, `fetch_url` | always-allow |
| `read_file`, `list_directory` | always-allow |
| `write_file`, `delete_file` | per-session |
| `run_command` (shell) | per-call (with diff preview) |
| `send_email`, `post_message` | per-call |
| `git_push`, `deploy_*` | per-call |
| `payment_*`, `charge_*` | always-prompt |

The user can override any policy in settings.

### Tool descriptions matter
Per Anthropic's published tool design notes, we run a tool description self-improvement pass nightly: an agent tests each tool description on a synthetic task suite and rewrites confusing descriptions. We saw a 40% completion-time improvement in their data; we'll measure ours.

## 8. Cost management

Every workflow has a **token budget** set at start (default: 100k tokens for free tier, 500k for Pro, unlimited for Pro+ with per-task limits). The orchestrator tracks tokens per agent in real time and:

- Surfaces live $$ in the UI with a token counter on each agent panel.
- Stops the workflow at 90% of budget and asks the user to extend.
- Defaults to cheap workers (Haiku, Flash, GPT-mini) for classification and simple subtasks; reserves Opus/GPT-5 for the supervisor.
- Caches prompts at provider level (Anthropic prompt caching, OpenAI prompt caching, Gemini context caching) - 50-90% savings on repeated context.

### Adaptive routing
A small router agent (Haiku) inspects each subtask and picks the cheapest worker that meets capability requirements. Supervisor can override but consumes its own token budget for the override decision.

## 9. Streaming to the UI

Every agent step emits structured events on a multiplexed stream:

```
{ type: 'agent_start', agent_id, ts }
{ type: 'token', agent_id, delta }
{ type: 'reasoning', agent_id, delta }
{ type: 'tool_call', agent_id, tool, args, call_id }
{ type: 'tool_result', call_id, result, error? }
{ type: 'state_update', key, value }
{ type: 'agent_done', agent_id, usage }
{ type: 'workflow_done', usage_total, cost }
```

The UI fans events into per-agent panels (council mode) or merges them into a single thread (chat mode). Tool calls render as collapsible cards with status pills. The activity strip at the top of council mode shows each agent's current verb ("Reading docs", "Generating plan").

## 10. Observability

Every workflow gets a trace ID that propagates through every agent call, tool call, and memory operation. Traces ship to:
- **Local audit log** (`~/.jarvis/logs/audit.jsonl`).
- **OpenTelemetry endpoint** (Logfire, Grafana, or user-configured).
- **In-app trace viewer** ("Show trace" button on any message).

The trace viewer renders a timeline with agent rows, tool spans, token counts, and links to the exact memory items each agent retrieved. This is the debug surface for users who want to understand why an agent did what it did.

## 11. Eval harness

20-task seed suite at MVP, expanding to 200+ by Phase 2. Each task has:
- input prompt,
- expected behaviors (must call tool X, must reference memory item Y, must complete in N turns),
- LLM-as-judge rubric prompt (0.0-1.0 + pass/fail),
- optional human review queue for edge cases.

Runs on every PR via GitHub Actions. Regressions block merge.

## 12. Differentiation summary

What this design does that BridgeMind, Cursor, and others don't:

1. **Voice-supervisor-on-top.** Jarvis sits above the council orchestrator. Most products bolt voice on as a side feature; we make it the primary input.
2. **Structured inter-agent messaging.** Agents can ask each other questions on a bounded channel. BridgeMind's BridgeSwarm explicitly disallows this; we measure the trade-off.
3. **Auto-extract action items.** A standing Action Extractor agent surfaces draft to-dos from every chat and meeting. No competitor does this in real time.
4. **Memory namespace isolation per agent.** Each agent has a scoped memory view; cross-agent contamination is bounded and observable.
5. **Live cost meter.** Per-agent token + dollar counters in the UI. Users can intervene before runaway loops.
6. **Trace-first debugging.** Every workflow has a queryable trace; users can see exactly why an answer happened.
7. **Adaptive model routing inside one workflow.** A workflow can use Opus for planning and Flash for fanned-out subtasks without the user configuring anything.

---

*See `04-voice-jarvis-layer.md` for the voice supervisor in detail and `06-todo-scheduler-notifications.md` for the action-extraction pipeline.*
