# VibeModel Foundry threat model

## Protected assets

- private source code, prompts, datasets, evaluation cases, feedback, adapters, checkpoints, and model cards;
- provider credentials, Supabase sessions, Stripe customer/subscription state;
- local filesystem integrity and host process safety;
- evaluation independence, promotion history, and audit evidence;
- user storage, memory, GPU/CPU availability, and network bandwidth.

## Trust boundaries and controls

| Boundary | Primary threats | Required controls |
|---|---|---|
| Renderer → native | command injection, path traversal, oversized input, confused-deputy writes | typed commands, constrained IDs, fixed app-data roots, strict byte/count limits, no shell strings |
| Native → worker | argument injection, unbounded output, hung/orphaned process, secret leakage | fixed executable, distinct args, stdin JSONL, bounded/redacted logs, timeouts, cancellation and process-tree kill |
| Model registry/download | malicious files, revision drift, remote code, license surprise, partial artifacts | approved hosts, pinned revision, mandatory checksum/size, basename-only files, atomic promotion, license review, `trust_remote_code` forbidden |
| Dataset ingestion | secrets/PII, prompt injection, unlicensed content, duplicate or evaluation leakage | consent/source metadata, secret/privacy scan, exact+normalized dedupe, split leakage checks, quarantine and explicit approval |
| Evaluation | judge leakage, teacher self-grading, hidden-set contamination, metric manipulation | immutable versioned suites, hidden-case access boundary, independent judge provenance, per-case evidence, deterministic gates |
| Promotion/deployment | automatic unsafe release, rollback loss, unhealthy route | explicit approval, safety/regression gates, append-only history, health check before registration, retained prior champions |
| Local persistence | corruption, symlink escape, partial write, schema confusion | app-data fixed root, canonical containment, validated schemas, unique temp+sync+atomic replace, backup generation |
| Supabase | cross-tenant reads/writes, client-forged plan, leaked raw data | `auth.getUser`, RLS/grants tests, server-authoritative entitlements, safe metadata allowlist, no raw content by default |
| Stripe | forged/replayed webhook, duplicate checkout/customer, partial entitlement update | raw-body signature, event and request idempotency, transactional writes, server price mapping, test mode until approved |

## Untrusted inputs

Treat project names, IDs, paths, imported files, archives, JSON/JSONL, URLs, model metadata, Hugging Face revisions, worker stdout/stderr, provider responses, evaluation prompts, judge outputs, feedback, webhook bodies, and browser persistence as untrusted.

Validation failures are ordinary product states. They return stable structured errors without raw secret content or filesystem internals. Quarantined artifacts are never executed or promoted.

## Prompt injection and model output

Imported text and model output never acquire tool authority. Dataset instructions cannot change system policy, select files, invoke a shell, approve promotion, consent to feedback, or reveal hidden evaluations. Tool execution continues through VibeSpace's existing approval boundary.

## Destructive actions

Delete, replace, rollback, cancel, clear, reset, download, train, promote, register, sync, checkout, and portal operations require scope-specific confirmation where data, money, bandwidth, or active work is affected. Deletion is bounded to validated Foundry-owned app-data paths. Production migrations, releases, live billing, and remote deletion require separate explicit approval.

## Residual risks and verification

- GPU discovery varies by OS/driver and must report unknown rather than guess.
- Antivirus can quarantine worker/install artifacts; recovery must retain state and provide a non-destructive diagnostic.
- Third-party model licenses may change; the pinned artifact retains reviewed license metadata but does not substitute for legal review.
- Real training dependencies are a substantial supply-chain surface and need locked hashes, scanner output, signing, and platform-specific smoke tests.
- Existing billing/backend weaknesses discovered outside this feature must be fixed or isolated before paid Foundry entitlements are enabled.
