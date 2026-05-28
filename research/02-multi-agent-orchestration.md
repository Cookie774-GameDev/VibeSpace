# Multi-Agent Orchestration Patterns & Frameworks - 2026 Research Report

*Subagent #2 - Public Web Research*
*Research date: May 2026*

---

## Executive Summary

The multi-agent landscape has matured rapidly through 2025 and into 2026. The field has consolidated around a handful of mature frameworks (LangGraph, Microsoft Agent Framework, OpenAI Agents SDK, Google ADK, CrewAI, Mastra, Pydantic AI), a universal tool/context protocol (Anthropic's MCP), and a parallel agent-to-agent protocol (Google's A2A). For a desktop/web app coordinating Claude, GPT, Gemini, and local models, the stack is now relatively prescriptive: pick a graph-based orchestrator, expose tools through MCP, route through a model gateway, persist memory in a vector store with a memory framework on top, and sandbox code execution. This report breaks each layer down with concrete recommendations.

---

## 1. Frameworks & Libraries

### LangGraph (LangChain)
LangGraph is a low-level, stateful orchestration framework. Agents are nodes, transitions are edges, and state is explicit. Key features: durable execution that resumes from failures, human-in-the-loop interrupts, short-term and long-term memory, and LangSmith for tracing. Python + JS/TS, MIT license. 33k+ GitHub stars. Trusted by Klarna, Replit, Elastic. Best-in-class for complex, long-running workflows where you need precise control. ([github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph), [docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/overview))

**Strengths:** maximum control, durable execution, mature ecosystem, supports any LLM provider, both Python and JS/TS.
**Weaknesses:** steeper learning curve than higher-level frameworks; verbose for simple cases.
**Desktop fit:** Good - JS/TS version makes it usable in Electron/Tauri or as a backend service.

### CrewAI
CrewAI is a higher-level Python framework with a two-layer model: **Flows** (structured, event-driven, stateful workflows) and **Crews** (autonomous teams of role-based agents). 100k+ certified developers. Designed around the metaphor of role-playing agents collaborating on tasks. ([docs.crewai.com](https://docs.crewai.com/introduction))

**Strengths:** intuitive role/task model, fast prototyping, good for content/research workflows.
**Weaknesses:** Python-only, less suited to fine-grained control; the "everything is a role-playing crew" abstraction can be limiting.
**Desktop fit:** Limited - would need a Python sidecar process.

### OpenAI Agents SDK (Swarm successor)
A lightweight Python SDK with very few primitives: **Agents**, **Handoffs** / **agents-as-tools**, and **Guardrails**. It's the production-ready evolution of the experimental Swarm project. Includes built-in tracing, sessions, MCP integration, sandbox agents (containerized workspaces), and realtime/voice agents. ([openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python/))

**Strengths:** minimal API, excellent tracing UX, first-class MCP and sandbox support, also supports non-OpenAI models via LiteLLM/any-llm extensions.
**Weaknesses:** Python-only, biased toward OpenAI Responses API patterns.
**Desktop fit:** Backend-only.

### Microsoft Agent Framework (AutoGen successor)
**Important:** AutoGen entered maintenance mode in 2025. Microsoft Agent Framework is the official successor, combining AutoGen's agent abstractions with Semantic Kernel's enterprise features. Provides individual **Agents** (LLM + tools + MCP) and graph-based **Workflows** for multi-step coordination with type-safe routing, checkpointing, and human-in-the-loop. Python + .NET. Supports Foundry, Anthropic, Azure OpenAI, OpenAI, Ollama, and others. ([learn.microsoft.com/en-us/agent-framework](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview))

**Strengths:** enterprise-grade, A2A and MCP built in, dual-language (.NET + Python).
**Weaknesses:** newer, smaller community than LangGraph; documentation still settling.
**Desktop fit:** Good - .NET version works well in Windows desktop apps; Python for backend.

### Google Agent Development Kit (ADK)
ADK 2.0 (GA) is the broadest-reach framework: **Python, TypeScript, Go, Java, and Kotlin**. Provides simple LLM agents, graph workflows (new in 2.0), template workflows (sequential/loop/parallel), agent routing, and the **A2A protocol** for agent-to-agent communication. Native Gemini integration but supports Claude, Ollama, vLLM, LiteLLM. ([google.github.io/adk-docs](https://google.github.io/adk-docs/))

**Strengths:** widest language support; mature graph workflows; first-class A2A.
**Weaknesses:** Google-cloud-tilted defaults; less community content than LangGraph.
**Desktop fit:** Excellent - TypeScript ADK is ideal for Electron/web apps.

### Pydantic AI
Five-level model: single agent -> agent delegation -> programmatic hand-off -> graph control flow -> deep agents (planning, file ops, sandboxed execution). Python-only with strict typing via Pydantic. Tight Logfire/OpenTelemetry instrumentation. ([ai.pydantic.dev/multi-agent-applications](https://ai.pydantic.dev/multi-agent-applications/))

**Strengths:** type safety, clean API, durable execution integrations (Temporal, DBOS, Prefect, Restate).
**Weaknesses:** Python-only, smaller ecosystem.

### Mastra
TypeScript-first agent framework explicitly aimed at embedding agents in web/desktop products. `npm create mastra@latest` scaffolds a project. Used by Replit, Sanity, Factorial. Templates for chat-with-PDF, browser agents, GitHub PR review, etc. ([mastra.ai/docs](https://mastra.ai/docs))

**Strengths:** TypeScript-native, integrates cleanly with Next.js, React, Astro, Express, SvelteKit, Hono. Built-in Studio UI.
**Weaknesses:** newer, narrower ecosystem than LangGraph.
**Desktop fit:** **Best-in-class** for a TS desktop/web app.

### Vercel AI SDK
Provides `ToolLoopAgent` and structured workflow patterns. The 6.x release simplifies the agent loop: `new ToolLoopAgent({ model, tools })` then `.generate({ prompt })` returns text + steps. Supports the AI Gateway for multi-provider routing. ([sdk.vercel.ai/docs/agents/overview](https://sdk.vercel.ai/docs/foundations/agents))

**Strengths:** TypeScript-native, excellent streaming UI primitives, ergonomic tool definitions.
**Weaknesses:** thinner multi-agent abstractions than LangGraph or Mastra; you compose patterns yourself.
**Desktop fit:** Excellent for the UI layer; pairs well with a more orchestration-heavy library.

### Anthropic MCP (Model Context Protocol)
Not a framework - a **protocol**. Open standard for connecting AI applications to tools, data, and prompts. Supported by Claude, ChatGPT, VS Code, Cursor, MCPJam. Servers expose tools/resources/prompts; clients (any agent) consume them. ([modelcontextprotocol.io](https://modelcontextprotocol.io/introduction))

**This is the most important piece of the stack for portability.** Build your agents as MCP clients and your tools as MCP servers, and they're swappable across every framework above.

---

## 2. Orchestration Patterns

These patterns recur across all frameworks. The right choice depends on parallelism vs. predictability.

| Pattern | When to use | Implementations |
|---|---|---|
| **Supervisor / Orchestrator-Worker** | A lead agent decomposes tasks and delegates to specialized workers; lead synthesizes results. Anthropic's Research feature uses this. Outperformed single-agent Claude Opus 4 by **90.2%** on internal evals. | LangGraph supervisor, CrewAI Crew, ADK collaborative workflow, Agent Framework graph workflow |
| **Sequential pipeline** | Predictable steps with handoffs (e.g. extract -> analyze -> summarize). | LangGraph, ADK sequential workflow, CrewAI Flow |
| **Hierarchical teams** | Subagents are themselves teams; supervisors of supervisors. Useful when scope is large. | LangGraph hierarchical example, CrewAI |
| **Swarm / handoff** | Agents pass control fully (not sub-call). Localized routing via tool calls. | OpenAI Agents SDK handoffs, AutoGen Swarm, Agent Framework |
| **Parallel / fan-out** | Independent subtasks run concurrently and results are joined. Anthropic found this cuts research time by up to **90%**. | LangGraph map-reduce, ADK parallel workflow, Pydantic Graphs parallel execution |
| **Selector group chat** | Centralized selector picks the next speaker from a shared context. | AutoGen / Agent Framework `SelectorGroupChat` |
| **Blackboard / shared state** | All agents read/write a shared state object; useful for collaborative scratchpads. | LangGraph state, LangChain MultiAgentCollaboration example |
| **Magentic-One** | Specialist team for open-ended tasks (web browsing, code, file handling). State-of-the-art on GAIA. | autogen-magentic-one, Agent Framework |

**Key lesson from Anthropic's production multi-agent research system:** token usage alone explained 80% of performance variance on BrowseComp. Multi-agent systems use ~15x more tokens than chats but unlock breadth-first parallelism that single agents cannot match. Reserve them for tasks with high parallelism and high value. ([anthropic.com/engineering/built-multi-agent-research-system](https://www.anthropic.com/engineering/built-multi-agent-research-system))

---

## 3. Inter-Agent Communication

Three layers exist in production systems:

**1. In-process message passing.** Cheapest. Frameworks like AutoGen Core, LangGraph, and ADK pass typed messages between agents in the same runtime. Use this for tight collaboration with shared memory.

**2. Agent-to-Agent protocols (A2A).** Google's [Agent2Agent Protocol](https://a2a-protocol.org) (now adopted by ADK, Agent Framework, and others) standardizes networked agent calls. Pattern: expose an agent as an A2A server; consume via a `RemoteA2aAgent` client proxy. Use when agents are separate services, owned by different teams, or written in different languages. ([google.github.io/adk-docs/a2a/intro](https://google.github.io/adk-docs/a2a/intro/))

**3. Event streams / message buses.** For decoupled, fan-out architectures, use Redis Streams, NATS JetStream, or Kafka. AutoGen's Core supports a distributed runtime built on this model.

**Practical recommendation for a desktop/web app:** keep most coordination in-process via your chosen framework's state mechanism. Add A2A only when you need to plug in third-party agents (e.g. a corporate SSO-protected service) or split heavy components into separate processes for stability.

---

## 4. Context & Memory Sharing

This is the hardest layer to get right. Three categories of solutions:

### Vector stores
| Store | License | Strengths |
|---|---|---|
| **Qdrant** | Apache 2.0 | Rust core, HNSW + filterable indexes, scalar/binary quantization (32x compression, 40x speedup), multi-tenancy via payload indexes. Excellent for production. ([qdrant.tech](https://qdrant.tech/articles/vector-search-resource-optimization/)) |
| **Chroma** | Apache 2.0 | Simple, embedded mode, great for local desktop apps |
| **LanceDB** | Apache 2.0 | Embedded columnar (Lance format), zero-config, excellent for desktop apps; can store millions of vectors locally |
| **pgvector** | PostgreSQL | Reuse existing Postgres; good for combined relational + vector |

### Long-term memory frameworks
- **mem0** ([docs.mem0.ai](https://docs.mem0.ai/overview)) - Managed memory layer with hosted vector store and rerankers. SDK plus integrations for LangChain, CrewAI, Vercel AI SDK. Add a few lines and get persistent user/agent/session memories.
- **Letta / MemGPT** ([docs.letta.com](https://docs.letta.com/quickstart)) - Stateful agents with explicit `memory_blocks` (e.g. `human`, `persona`). Each agent has an ID and persistent state. Especially strong for long-running assistants.
- **Zep** - Conversation-focused long-term memory with summarization and graph extraction.
- **LangGraph store** - Built-in long-term memory primitive that pairs naturally with the LangGraph state machine.

### Patterns for safe sharing across agents
1. **Per-agent isolated context + summarized handoffs.** Each subagent has its own context window; the lead agent gets only condensed results. This is what Anthropic uses in production.
2. **Filesystem artifacts.** Subagents write outputs to a shared filesystem (or virtual FS) and pass references back, avoiding the "game of telephone" through the orchestrator.
3. **Scoped memory namespaces.** Tag memories with `tenant_id`, `user_id`, `agent_id`, and `session_id`. Qdrant's `is_tenant=True` payload index colocates vectors per tenant for performance.
4. **External plan storage.** Persist the lead agent's plan to memory before it might be truncated by context overflow.

---

## 5. Tools & Function Calling

**MCP is now the default standard.** It gives you:
- A single tool definition that works across Claude, ChatGPT, Cursor, VS Code, and any framework with MCP client support.
- Servers can expose tools (functions), resources (data), and prompts (templates).
- Stdio transport for local servers, HTTP/SSE for remote.

For a desktop app:
- Ship local MCP servers for filesystem, shell, git, browser automation. Reuse the existing ecosystem (Playwright MCP, GitHub MCP, etc.).
- Expose remote MCP servers for cloud integrations (Notion, Slack, Google Drive).
- Build a **tool registry** UI so users can install/enable MCP servers; mirror Claude Desktop's pattern.

Beyond MCP, every framework also supports native function tools (Python decorators, Zod schemas in TS). Use those for in-process tools where MCP overhead isn't justified.

**Tool design lessons from Anthropic's research system:**
- Tool descriptions matter as much as code. Bad descriptions send agents down wrong paths.
- Have an agent test and rewrite ambiguous tool descriptions - they reported a 40% decrease in task completion time after this self-improvement loop.
- Match tool granularity to agent intent: prefer specialized tools over generic ones.
- Parallel tool calling is now table stakes - single agents that fire 3+ tools concurrently easily out-perform sequential agents.

---

## 6. Streaming & Realtime

For a multi-agent UI that streams several agents' output simultaneously, the proven stack is:

**Backend -> UI transport:**
- **Server-Sent Events (SSE)** - simplest, one-way, perfect for token streams. Works with HTTP/2 multiplexing.
- **WebSockets** - bidirectional; use when the UI needs to interrupt or steer agents mid-stream.
- **Vercel AI SDK UI Message Stream** - battle-tested protocol that handles tool-call streaming, structured data, errors, and resumption.

**Streaming patterns:**
- **Per-agent channel.** Open a separate stream per active agent and let the UI render them in parallel panes (Anthropic's Claude Code does this).
- **Multiplexed event stream.** One stream with `agent_id` on each event; UI fans events out into per-agent views. Lower connection count.
- **Interleaved thinking.** Stream the orchestrator's reasoning + subagents' tokens together with clear typing on each event. Both LangGraph and OpenAI Agents SDK support this.

**Async-first design.** Anthropic explicitly called out **synchronous subagent execution as the bottleneck** in their research system. Plan for async execution and event-driven coordination from day one.

---

## 7. Cost & Token Management

Multi-agent systems burn tokens. A few proven strategies:

**Model routing / gateway**
- **LiteLLM Router** ([docs.litellm.ai](https://docs.litellm.ai/docs/routing)) - production-grade router with weighted-pick, latency-based, usage-based, least-busy, and cost-based strategies. Cooldowns, retries, fallbacks across providers. Self-hosted or proxy mode.
- **OpenRouter** - single API across 200+ models with provider routing and automatic fallbacks.
- **Vercel AI Gateway** - managed routing for Vercel-deployed apps.
- **Microsoft Foundry / Apigee AI Gateway** - enterprise gateways with managed model catalogs.

**Routing strategies that work in practice:**
1. **Tiered routing.** Use Haiku/Flash/GPT-mini for classification and simple subtasks; reserve Opus/GPT-5/Gemini Pro for the lead agent. Anthropic measured a 90% gain when Opus orchestrated Sonnet workers.
2. **Cost-budgeted runs.** Set hard ceilings per task (Pydantic AI's `UsageLimits`, OpenAI Agents SDK's usage tracking).
3. **Cache prefix-stable prompts.** Anthropic prompt caching, OpenAI prompt caching, and Gemini context caching all give 50-90% savings on repeated context.
4. **Compaction.** ADK and LangGraph support automatic context compaction; Pydantic AI offers message-history processors. Summarize completed phases and discard raw turns.
5. **Local model fallback.** Route fact lookups and embedding work to Ollama/vLLM on the user's machine when latency-tolerant. Llama 3 and Qwen 3 8B are good enough for many tool-calling subtasks.

**Practical accounting:** track tokens per agent and per task. Production multi-agent systems should display cost-to-date in the UI so users can intervene before runaway loops.

---

## 8. Sandboxing & Safety

When agents execute generated code or touch the filesystem, you need isolation.

| Sandbox | Best for | Notes |
|---|---|---|
| **E2B** ([e2b.dev/docs](https://e2b.dev/docs)) | Cloud-hosted Linux VMs for AI agents. Python + JS SDKs. | Computer-use desktops, CI/CD use cases, long-lived sessions. Battle-tested by ChatGPT/Claude code interpreters. |
| **Daytona** ([daytona.io/docs](https://www.daytona.io/docs/)) | OCI/Docker-compatible sandboxes that boot in **<90ms**. SDKs in Python, TS, Ruby, Go, Java. | Stateful environment snapshots for resumable agent operations. Mount volumes, regional deployment. |
| **Docker** | Full local control; use with rootless runtimes for safety. | Heavier to start but free and offline. |
| **WebContainers** ([webcontainers.io](https://webcontainers.io/guides/introduction)) | Node.js + OS commands **inside the browser tab** - zero server cost. | Powers StackBlitz, Bolt.new. Ideal for an in-browser code agent without backend infra. Limited to Node-compatible workloads. |
| **OpenAI Agents Sandbox** | First-class sandbox agents with manifest-defined files, capabilities, and resumable sessions. Unix local + Docker drivers. | Good if you're already in the OpenAI Agents SDK ecosystem. |

**Safety guardrails to implement regardless of sandbox:**
- Capability allowlists (filesystem paths, network domains, env vars).
- Resource limits (CPU, memory, wall clock, output bytes).
- Human-in-the-loop approval for destructive operations (delete, push, run with elevated rights).
- Audit logs of every tool call.
- Treat all third-party MCP servers as untrusted; sandbox them by default.

For a desktop app specifically: **WebContainers** for the in-browser agent panel + **Daytona/E2B** for heavier server-side workloads gives you the best of both worlds. Local Docker is fine for power users with the daemon installed.

---

## 9. Concrete Recommendations for the App

Given the requirements (desktop/web, parallel agents, handoffs, shared context, virtual assistant orchestrator across Claude/GPT/Gemini/local), here's the recommended stack:

### Orchestration layer - pick one of two
- **Option A - TypeScript-first (recommended for a TS/Electron/Tauri app):** Mastra for the orchestration core (agents, workflows, memory primitives) with Vercel AI SDK for the streaming UI layer. Both interoperate cleanly. Mastra's templates accelerate the first 80% of the build.
- **Option B - Polyglot with Python backend:** LangGraph (Python) as the orchestration server, exposed via SSE/WebSocket. Use the JS SDK on the client to invoke graphs, stream events, and handle interrupts. This buys the most flexibility and the largest ecosystem.

For complex, long-running flows (research assistants, data pipelines), LangGraph's durable execution and human-in-the-loop interrupts are hard to beat. For chat-shaped, lightweight multi-agent setups, Mastra is faster to ship.

### Agent topology
Adopt a **supervisor + specialist workers** pattern as the default, with parallel fan-out for breadth-first tasks:
- One **virtual assistant supervisor** (Claude Opus or GPT-5) that owns the conversation, decomposes tasks, picks workers, and synthesizes results.
- A pool of **specialist workers** (Sonnet, Gemini Flash, GPT-mini, Llama via Ollama) selected per task.
- A **memory agent** that reads/writes to the long-term store between turns.
- **A2A endpoints** only for agents that must run as separate services.

### Tools
Adopt MCP everywhere. Ship a curated catalog of MCP servers (filesystem, browser, git, shell, search, calendar, mail) and let users install third-party servers through a registry UI.

### Memory
- Short-term: framework-native state (LangGraph state, Mastra memory).
- Long-term: **Qdrant** (server) or **LanceDB** (embedded for desktop) as the vector store, with **mem0** or **Letta** as the memory framework on top. Letta is the better choice if you want explicit memory blocks and stateful per-user agents; mem0 is faster to set up.

### Model routing
**LiteLLM** (self-hosted) or **OpenRouter** as the gateway. Model selection rules:
- Default supervisor: Claude Opus 4 / GPT-5.
- Default workers: Claude Sonnet 4 / Gemini Flash / GPT-5-mini.
- Fallback: local Llama/Qwen via Ollama.
- Failover and cooldowns at the gateway, not in agent code.

### Streaming
SSE with the Vercel AI SDK UI Message Stream protocol. One stream per active agent, multiplexed in the UI. Display per-agent status, tokens, tool calls, and live cost.

### Sandboxing
WebContainers for in-browser code execution; E2B or Daytona for server-side; Docker for power users running locally. Any code execution surfaces a confirmation prompt unless the user has approved a per-tool allowlist.

### Observability
LangSmith, Logfire, or OpenTelemetry to a self-hosted Grafana/Prometheus stack. Trace every agent decision, tool call, and token-cost - Anthropic's experience makes clear that without observability, multi-agent debugging is intractable.

### Evaluation
Start with 20 hand-curated tasks. Use LLM-as-judge with a single rubric prompt scoring 0.0-1.0 plus pass/fail. Add human review for edge cases. Don't wait until you have hundreds of test cases - start now.

---

## Sources
1. [LangGraph Multi-Agent Workflows blog](https://blog.langchain.com/langgraph-multi-agent-workflows/)
2. [LangGraph GitHub](https://github.com/langchain-ai/langgraph)
3. [CrewAI Documentation](https://docs.crewai.com/introduction)
4. [OpenAI Agents SDK Docs](https://openai.github.io/openai-agents-python/)
5. [AutoGen GitHub (maintenance mode notice)](https://github.com/microsoft/autogen)
6. [Microsoft Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview)
7. [Google ADK Documentation](https://google.github.io/adk-docs/)
8. [Google A2A Introduction](https://google.github.io/adk-docs/a2a/intro/)
9. [Anthropic MCP Introduction](https://modelcontextprotocol.io/introduction)
10. [Pydantic AI Multi-Agent Patterns](https://ai.pydantic.dev/multi-agent-applications/)
11. [Vercel AI SDK Agents](https://sdk.vercel.ai/docs/foundations/agents)
12. [Mastra Documentation](https://mastra.ai/docs)
13. [Mem0 Platform Overview](https://docs.mem0.ai/overview)
14. [Letta Quickstart](https://docs.letta.com/quickstart)
15. [Qdrant Resource Optimization Guide](https://qdrant.tech/articles/vector-search-resource-optimization/)
16. [E2B Documentation](https://e2b.dev/docs)
17. [Daytona Documentation](https://www.daytona.io/docs/)
18. [WebContainers Introduction](https://webcontainers.io/guides/introduction)
19. [LiteLLM Router](https://docs.litellm.ai/docs/routing)
20. [Anthropic - How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system)
