# Pet, Prompt Forge, and Hourly Benchmark Design

## Scope

This change contains three independent user-facing repairs:

1. The enabled desktop pet remains visible and animated while its mini panel is open. Clicking the pet may open or focus the panel, but it never hides the pet.
2. Prompt Forge previews its upgraded prompt directly inside the composer instead of opening a modal. The compact action row offers Accept, Redo, Add context, and Restore original. Accept keeps the upgraded text in the composer and leaves sending to the normal Send button.
3. Benchmarks no longer render the embedded “Curated Top 50” provenance notice. Cloudflare news ingestion and the app refresh path run hourly. Verified model-release news is surfaced as an unranked “benchmark pending” candidate until a real benchmark score exists; no score is invented.

## Reliability boundaries

- Pet visibility is governed by enabled/shutdown/overlay truth, not panel visibility. The existing single animation loop and texture cache remain unchanged.
- Prompt Forge retains the original prompt until Accept, supports deterministic restore, and never auto-sends an upgraded prompt.
- Cloudflare ingestion retains its D1 lease, fencing, retry, and last-known-good behavior. The UI distinguishes live data, stale last-known-good data, and pending unranked model releases.
- Hourly refresh uses a single-flight scheduler and visibility/online wakeups rather than a high-frequency polling loop.
- Cloud deployment and forced refresh are verified without logging credentials, request bodies, or secret values.

## Non-goals

- No provider, model-routing, authentication, native watchdog, terminal, or unrelated theme changes.
- No fabricated benchmark ranks or scores.
- No paid service or billing configuration changes.
