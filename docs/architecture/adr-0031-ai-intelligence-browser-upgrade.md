# ADR-0031: Native Intelligence and Browser Codex Upgrade

- Status: Accepted for incremental implementation
- Program: `VS-PR31-INTELLIGENCE-AND-BROWSER-UPGRADE`
- Date: 2026-08-03
- Scope: PR #31 successor worktree

## Decision

Extend VibeSpace's existing Shared Intelligence Kernel, Context Map, Prompt
Forge, skill loader, approval engine, artifact system, execution journal, MCP
manager, and browser security boundary. Do not install competing agent,
retrieval, memory, routing, approval, or orchestration frameworks.

The program has two connected product workstreams:

1. Native Chat/App intelligence: provider-aware token preflight, deterministic
   context budgeting, repository intelligence, temporal knowledge, usage
   evidence, progressive skill disclosure, and privacy-safe observability.
2. Browser Codex execution: typed native capability brokers, durable goals and
   checkpoints, one logical MCP gateway, isolated browser execution, canonical
   evidence, recovery, and fail-closed completion.

Shared authority, usage, telemetry, trust, artifact, and provider contracts are
implemented once and reused by both workstreams.

## Compatibility baseline

Every new runtime path is feature-flagged and off by default. The off state:

- preserves the selected provider and model;
- preserves current prompt and context behavior;
- performs no new compression, routing, memory, caching, browser execution, or
  external telemetry;
- does not start new background processes or network services;
- does not change approval, Git, billing, or production-data authority.

## Token Optimize

The product exposes `Off`, `Token Saver`, `Normal`, and `Token Final Boss`.
Optimization protects system/safety instructions, the newest user message,
explicit attachments, pinned Context Map nodes, approval requirements, tool
schemas, quoted preserved text, exact patches, structured tool data, and secret
warnings. It may remove only optional context with a recorded reason.

Token counting is model-aware when a reviewed local tokenizer or explicitly
authorized provider-native counter is available. Unknown models use a clearly
labeled conservative estimate. Provider-reported usage is reconciled after the
request without rewriting the preflight estimate. Optimization never silently
switches models.

## Repository and Context Map intelligence

Tree-sitter supplies incremental syntax facts. Repomix and Aider contribute
selected ranking and packaging patterns behind VibeSpace-owned interfaces.
Dexie and Tantivy remain authoritative. Graphiti temporal concepts may inform
the native schema; Graphiti and LanceDB runtimes remain benchmark-only until
they prove a material advantage.

## Native and browser execution authority

Native file, terminal, Git, browser, and MCP operations consume the existing
issued approval/execution authority. A broker cannot mint approval. Exact
account, project, run, request, attempt, capability, operation, parameters,
workspace, branch, and revision bindings are verified before any external
effect. Claims are single-use and canonical results are journaled.

Browser and MCP content remains external-untrusted data. Returned text cannot
grant authority, change policy, expose credentials, or prove completion.
Completion requires canonical evidence observed after the final mutation and
must satisfy every mandatory acceptance criterion.

## Observability and privacy

Local observability records bounded timing, provider/model identifiers, token
counts, source counts, retries, operation names, result states, and stable error
codes. It does not record raw prompts, responses, source contents, credentials,
private paths, terminal output, browser contents, or tool arguments containing
user data. External export is absent and disabled by default.

## Open-source adoption

Only audited, pinned components that materially improve VibeSpace are adopted.
Every copied or distributed component requires a license entry, applicable
NOTICE material, a modification record, and installer-size measurement.
Development-only evaluation tools are excluded from the desktop bundle.

## Delivery policy

Implementation proceeds in coherent, independently owned batches. Focused
tests run only for changed behavior and material risk. Broader builds,
integration suites, performance measurements, visual verification, and
license/installer closeout run at the phase boundaries that require them.
