# Local Agent Runtime and Verified Model Catalog Design

## Scope

Prompts 12 and 13 extend the existing VibeSpace local-model stack. They do not
create a second agent framework. The implementation reuses the bounded local
knowledge retriever, canonical approval authority, typed action planner, local
Ollama provider, model routing, and Local Models settings surface.

Prompt 11 remains the authority for consent-based Ollama installation. This
design may establish or call that lifecycle boundary, but it must not restore
silent installation or execute an installer without the required consent.

## Runtime policy

The user selects one local runtime mode:

- **Fast** performs one compact retrieval and one local inference request.
  Thinking is disabled or minimized through model-supported Ollama options.
  It does not start a background planner or verifier.
- **Deep** performs bounded retrieval, then uses the existing typed
  Planner → approval-bound Executor → evidence Verifier path. A failed or
  evidence-free verification cannot be reported as task completion.

Both modes use the existing local context-map retrieval. Only bounded ranked
excerpts, source identity, and compact provenance are added to the request.
Whole directories and unbounded files are never inserted into the prompt.

Tool capability is descriptive until the local model proposes a registered
action. Every proposal passes through the existing action catalog and
canonical approval authority. Files, terminal, search, calendar, and app
controls receive no alternate execution path. Destructive operations retain
their existing approval rules.

No heavy scheduler or task manager runs continuously. Runtime orchestration
exists only for an active request and is abortable.

## Cloud escalation

Cloud escalation is disabled by default. Enabling it only permits VibeSpace to
offer an escalation after a classified local inference failure or an
unsupported complex capability.

Every escalation remains a separate user decision. Before data leaves the
device, the UI discloses:

- why local execution failed;
- the exact provider and model;
- the bounded categories and approximate size of data to be sent;
- that the next request leaves the local runtime.

No request is sent until the user confirms that disclosure. Fully Local Chat
always returns a local-only refusal before provider resolution and cannot be
overridden by the escalation preference. Public research and automatic cloud
model routing remain disabled in Fully Local Chat.

## Catalog contract

The existing catalog gains structured, immutable metadata for each requested
model:

| Display label | Ollama identifier | Default format | Download | Context | License |
| --- | --- | --- | ---: | ---: | --- |
| Qwen3.6 35B-A3B | `qwen3.6:35b-a3b` | Q4_K_M | 24 GB | 256K | Apache-2.0 |
| GPT-OSS 20B | `gpt-oss:20b` | MXFP4 | 14 GB | 128K | Apache-2.0 |
| Qwen3.5 4B | `qwen3.5:4b` | Q4_K_M | 3.4 GB | 256K | Apache-2.0 |

Resource guidance is intentionally approximate. It states storage, practical
system-memory headroom, GPU guidance, speed class, CPU practicality, supported
input/tool/thinking capabilities, quantization, context, license, and source
URL. None of the new models is marked recommended.

Catalog actions reuse one lifecycle:

1. establish a healthy local Ollama connection;
2. check disk guidance;
3. pull with progress and cancellation;
4. verify the tag exists;
5. perform a bounded real chat probe;
6. surface success or an actionable failure.

Update and Repair force a verified pull. Remove uses Ollama's local delete API
after confirmation. Ollama does not expose resumable pull state, so Pause is
shown as unsupported rather than simulated; Cancel is real and Retry restarts
the pull.

## Error handling

Errors are classified into unavailable runtime, missing installation,
insufficient storage, cancelled download, pull failure, verification failure,
unauthorized tool, verifier failure, local inference failure, escalation
refusal, and unsupported capability. User messages remain bounded and never
include secrets, raw provider payloads, or terminal commands.

## Verification

Test-first coverage must demonstrate:

- Fast/Deep option mapping and persistence;
- bounded RAG context and no background work;
- tool authorization cannot bypass canonical approvals;
- verifier failure prevents completion;
- local inference failure produces only a disclosure proposal;
- Fully Local Chat refuses escalation and hides cloud connections;
- exact labels, identifiers, metadata, and no invented recommendation;
- download connection-first behavior, cancellation, forced repair/update,
  deletion, verification, and launch probe;
- the Local Models user flow, not only helper functions.

Focused TypeScript, formatting, and diff checks follow the behavior tests.
Actual large downloads are performed only when the machine has an installed
Ollama runtime and sufficient resources; unavailable hardware is reported
truthfully rather than replaced with fabricated evidence.
