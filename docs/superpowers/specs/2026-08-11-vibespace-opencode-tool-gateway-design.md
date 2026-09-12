# VibeSpace OpenCode Tool Gateway Design

## Goal

Let OpenCode operate audited VibeSpace product features through a small
semantic API while VibeSpace remains the outer permission and execution
authority. No model-controlled request may name or invoke an arbitrary Tauri
command.

## Chosen architecture

VibeSpace generates one local OpenCode plugin inside its private
`OPENCODE_CONFIG_DIR`. The plugin registers the exact semantic tool names from
the PR31 goal and forwards bounded JSON requests to a loopback-only native
gateway. The OpenCode child receives the gateway address and a fresh
per-process bearer token through its private environment.

The native gateway:

- accepts only `POST /v1/tool` on `127.0.0.1`;
- requires the exact ephemeral bearer token;
- rejects oversized bodies, duplicate request IDs, unknown tools, invalid
  session/project scope, unsafe directories, and non-object arguments;
- emits a typed Tauri event to the renderer and waits for one bounded typed
  response;
- never accepts a native command name or generic invoke payload;
- bounds concurrency, response size, wait time, and logs without secrets.

The renderer gateway host validates every tool's arguments again and dispatches
to a fixed semantic handler. Production handlers use existing VibeSpace stores,
repositories, terminal APIs, action registrations, and permission authority.
They return structured, size-bounded results.

## Tool catalog

The plugin exposes:

- `terminal.list`, `terminal.open`, `terminal.focus`, `terminal.spawn`,
  `terminal.write`, `terminal.read`, and `terminal.schedule`;
- `command.list` and `command.run`;
- `profile.allAboutMe.read` and `profile.allAboutMe.update`;
- `memory.learning.read` and `memory.learning.update`;
- `context.list`, `context.read`, `context.attach`, and `context.update`;
- `skills.list` and `skills.load`;
- `plugins.list` and `plugins.run`;
- `tasks.create` and `tasks.update`;
- `schedule.create`;
- `app.navigate` and `app.getState`.

Names and schemas are static. Strings, arrays, pagination, output, terminal
transcripts, and update bodies have explicit maximum sizes. No catch-all tool
exists.

## Permission flow

The production OpenCode config denies raw edits, shell execution, task launch,
and external-directory access unless a later audited policy explicitly grants
them. Read/search remains available only within the scoped working directory.
Semantic mutation tools are configured as `ask`; read-only semantic tools may
be `allow`.

When OpenCode emits `permission.asked`, the event bridge adds a
`permission_request` part to the active assistant placeholder. The existing
VibeSpace permission card responds directly to the exact OpenCode session and
approval ID:

- Approve once → `once`;
- Approve all safe changes → `always`;
- Deny → `reject`;
- Edit request → reject the current request, then send the narrowed instruction
  as a new VibeSpace turn.

The bridge keeps final message state synchronized so a completed response
cannot restore a stale pending card. Ask mode exposes no mutation tools. Plan
mode permits reads but denies mutations. Agent mode exposes the semantic
catalog while both OpenCode and VibeSpace policy remain enforceable.

## Execution and result behavior

Read-only handlers execute immediately after validation and return bounded
structured JSON. Mutation handlers execute only after the matching permission
reply. Terminal tools target existing visible VibeSpace panes and PTYs; they
must not substitute OpenCode's internal shell when a visible terminal is named.

Errors use stable codes and actionable messages. Raw secrets, stack traces,
private app-data paths, bearer tokens, and arbitrary native error bodies are
never returned to OpenCode.

## Verification

Automated tests cover:

- exact catalog and schemas;
- config permissions and generated plugin content;
- loopback binding, bearer authentication, body/result limits, unknown tools,
  duplicate IDs, timeout, and cancellation;
- frontend top-level and per-tool validation;
- representative terminal, context, All About Me, Learning, and app tools;
- approval event presentation and exact once/always/reject routing;
- Ask/Plan/Agent tool policy;
- absence of `tauri.invoke` or arbitrary command fields;
- redaction and ordinary production command-authority checks.

Focused TypeScript and Rust suites, typecheck, formatting, build checks, and a
live safe read-only OpenCode tool smoke complete the phase.
