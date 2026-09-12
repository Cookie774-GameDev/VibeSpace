# OpenCode-Only Production Routes Design

## Goal

Make the production `runAgent` architecture structurally OpenCode-only after
feature parity, without deleting provider metadata, provider settings,
credential management, usage readers, migrations, or the explicitly gated
kernel smoke transport.

## Current residual surface

Normal `runAgent` calls already dispatch through `dispatchThroughOpenCode`, but
`router.ts` still imports every native provider implementation and external CLI
adapter. It exports `runExternalConnection`, retains general native provider
resolution, and accepts an `external-cli` connection ID in the OpenCode
selection path. Model-switch action candidates can also include external CLI
connections. These are dead or misleading production Chat surfaces even though
the main dispatch currently bypasses them.

## Design

`runAgent` keeps exactly two dispatch branches:

1. the explicit build-flagged kernel smoke provider, used only for protected
   integration evidence; and
2. OpenCode for every ordinary production request.

The router will stop importing ordinary native provider implementations and
ordinary external CLI adapters. The old public `runExternalConnection` seam
and its tests will be removed. The remaining private CLI execution helper will
accept only the kernel smoke attestation path and only the kernel smoke
adapter/connection identity.

`resolveOpenCodeSelection` will reject every `external-cli` connection before
model translation. External CLI connections remain available to Settings,
authentication detection, terminal launch helpers, and taskbar usage readers,
but cannot be selected as Chat transport metadata.

Jarvis model-switch candidate construction will exclude `external-cli`
connections. Native API and local connection metadata remain selectable;
OpenCode remains responsible for actual model execution.

## Verification

Architecture tests will assert:

- the ordinary router branch has one OpenCode dispatch;
- ordinary native providers and external CLI adapters are not imported by the
  router;
- no exported external-connection runner remains;
- external CLI connection IDs fail before harness dispatch;
- model-switch candidates omit external CLI connections;
- kernel smoke tests continue to pass.

Focused router, smoke, model selection, runtime, Prompt Forge, Model Foundry,
adapter, and harness suites plus typecheck/build and source scans provide the
release gate.
