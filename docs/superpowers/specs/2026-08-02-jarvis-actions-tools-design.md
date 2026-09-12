# Jarvis Actions and Custom Tools Design

## Scope

Finish Prompt 25 while preserving the existing approval engine and Custom Tools page.

## Design

- Close Settings synchronously before routing to `tools`.
- Preserve the current built-in catalog and expose custom commands through the existing `custom.*` resolver; do not advertise unsupported handlers.
- Add lightweight token-based hover/focus transitions with reduced-motion suppression to the Settings page.
- Verify proposals, single approval, approve-all stopping on failure, rejection/cancellation, invalid commands, custom tool resolution, and explicit trusted-auto-approval behavior through existing and focused tests.

## Boundaries

No Custom Tools redesign, action-handler expansion, approval-engine rewrite, model-provider special casing, dependency, or external mutation.
