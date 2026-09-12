# Build Your Own AI requirement traceability

Status values are `not started`, `in progress`, `implemented`, `verified`, or `external gate`. A requirement is not marked verified without linked test or manual evidence.

| Requirement group | Implementation surface | Evidence | Status |
|---|---|---|---|
| Governance, discovery, ownership, baseline | `docs/AGENT_COORDINATION.md`, `DISCOVERY.md` | Recorded baseline outputs and current conflict report | implemented |
| Versioned contracts and VibeCoder template | `app/src/features/model-foundry/domain.ts`, `validation.ts` | Task 1 unit tests | in progress |
| Deterministic fixture vertical slice | `fixtureBackend.ts`, `localRepository.ts` | Task 1 lifecycle/recovery tests | in progress |
| Create wizard and overview/dashboard | `app/src/features/model-foundry/ui/**` | Component tests, screenshots, keyboard audit | not started |
| Dataset import, scanning, dedupe, quality, splits, versioning | `app/src/features/model-foundry/dataset/**`, native store | Unit/property/integration tests | not started |
| Hardware profiler and resource guard | `app/src-tauri/src/model_foundry/hardware.rs` | Parser fixtures and native/manual platform evidence | not started |
| Safe model registry/download/offline state | frontend registry + native artifacts/downloads | Manifest/download/failure-injection tests | not started |
| Durable job supervisor and worker protocol | Rust `jobs/process`, Python worker | Rust + worker protocol/cancel/restart tests | not started |
| Real LoRA/QLoRA opt-in path | `workers/vibemodel-foundry/**` | Tiny fixture model run and manifest | not started |
| Evaluation Arena and independent gates | evaluation domain/worker/UI | Deterministic cases, leakage and regression tests | not started |
| Explicit promotion, model card, registry, rollback | registry domain/native/UI | Gate, health, rollback and restart tests | not started |
| Existing local-model picker routing | provider/model registry integration | Picker health and specialist workflow tests | not started |
| Approved feedback and improvement cycles | feedback domain/UI/local store | Consent/provenance/replay tests | not started |
| Slash commands and agent roles | command/action registry integration | Parsing, approval, and permission tests | not started |
| Supabase safe metadata/RLS/audit | migration `0031`, SQL tests, types | Fresh reset plus ownership/grant/advisor evidence | not started |
| Server-authoritative plan limits/usage | entitlement helpers/RPCs/functions | Limit, idempotency, retry/concurrency tests | not started |
| Existing Stripe checkout/portal/webhook reuse | existing Edge functions + hardening | Stripe test-mode round trip and replay evidence | not started |
| Privacy, consent, licenses, model cards, deletion | contracts/UI/native/docs | Security, retention, deletion and export tests | not started |
| Observability/diagnostics without secrets | event envelope + diagnostic export | Redaction, bounds, correlation/recovery tests | not started |
| Accessibility, motion, responsive visual polish | Foundry UI | Automated checks and required screenshots | not started |
| Failure-injection matrix | all layers | Evidence package per scenario | not started |
| Required repo/build/native/worker/database gates | CI/local verification | Final test report | not started |
| Production deployment/live Stripe/release | external systems | Explicit approval and operator evidence | external gate |

## Evidence rule

Fixture evidence is labeled fixture. Manual evidence records platform and build. External gates are never converted to verified based on mocks, screenshots, assumed credentials, or local schema inspection.
