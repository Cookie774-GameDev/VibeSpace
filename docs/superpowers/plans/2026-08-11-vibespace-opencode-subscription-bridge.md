# OpenCode Subscription Bridge Implementation Plan

**Goal:** Replace legacy CLI sign-in handoffs with bounded, authenticated
OpenCode provider OAuth flows while preserving truthful unsupported-provider
messaging and API-key alternatives.

**Authority:** PR31 master goal Phase 8; OpenCode 1.18 server provider auth
contract (`GET /provider/auth`, `GET /provider`,
`POST /provider/{providerID}/oauth/authorize`, and OAuth callback).

**Scope:** `app/src/lib/harness/openCodeClient.ts` and tests; a focused
OpenCode subscription bridge module and tests; Subscription Bridge UI and
tests; Phase 8 coordination records.

**Exclusions:** token/cookie scraping, direct provider OAuth implementation,
Anthropic Pro/Max bridging, legacy CLI use as a Chat harness, local models,
production `runAgent` switching, live authentication during automated tests,
and unrelated dirty work.

## Task 1: Typed OpenCode auth client

1. Add failing tests for authenticated provider/auth list, authorize, and
   callback requests, bounded schema parsing, path encoding, and redacted
   errors.
2. Add the four typed client operations without exposing OpenCode auth
   material.
3. Run the focused OpenCode client suite and typecheck.

## Task 2: Truthful subscription policy and flow

1. Add failing fixtures for OpenAI, GitHub Copilot, xAI, GitLab, dynamically
   exposed official OAuth methods, connected state, code and automatic
   callbacks, malformed responses, and Anthropic exclusion.
2. Implement dynamic method discovery and method-index preservation. Never
   hardcode a secret or manufacture provider credentials.
3. Validate external authorization URLs, bound all display copy, call
   OpenCode’s callback, then refresh provider/model truth.

## Task 3: VibeSpace connection-center UI

1. Add failing component tests for OpenAI subscription connect, device/code
   instructions, connected refresh, API-key alternative, and explicit
   Anthropic Pro/Max unavailability.
2. Render OpenCode-owned subscription routes when the owned harness is ready;
   retain legacy CLI metadata only as migration/status UX.
3. Run focused Settings/harness tests, typecheck, scoped formatting/diff
   checks, then commit and release the Phase 8 lock.
