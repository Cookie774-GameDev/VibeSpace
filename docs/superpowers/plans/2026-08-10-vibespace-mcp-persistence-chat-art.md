# Persistent VibeSpace MCP and Chat Welcome Art Plan

1. Freeze relevant source, test, asset, package, and deployment baselines.
2. Add RED tests for app-lifetime relay ownership and external status
   publication.
3. Add RED BridgeClient tests for registration timeout, heartbeat liveness,
   socket generations, non-overlapping reconnect, and stable-period backoff.
4. Add RED Worker heartbeat acknowledgement and OAuth capability tests.
5. Implement the runtime host and status store; mount it in the stable
   authenticated boundary; convert Browser Chat to a status consumer.
6. Implement the generation-owned BridgeClient state machine and Worker
   acknowledgement.
7. Harden MCP preflight and update truthful ChatGPT Apps/Developer Mode copy.
8. Generate one edit for each Default, MonoChrome, and Jarvis Core welcome
   image, preserve composition, convert to optimized 512×512 WebP, and verify
   exact outer-background blending. Do not touch Warm.
9. Run focused tests after each slice, then TypeScript, relevant Vitest suites,
   production build, Worker tests/typecheck/dry-run, formatting, diff, and
   credential checks.
10. Commit logical artwork and MCP slices. If every local gate passes, deploy
    only `vibespace-mcp` and verify live health, discovery, OAuth metadata, and
    anonymous challenge. Do not merge, push, install, or release PR31.
