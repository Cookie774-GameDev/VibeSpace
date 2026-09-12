# Qwen Provider and Official Provider Brands Implementation Plan

1. Add failing focused contracts for Qwen provider identity, current fallback
   models, secure key storage, API-key validation, model discovery, streaming,
   Settings enrollment, and shared official brand rendering.
2. Add `qwen` to the provider type, secure vault allowlist, model/default
   catalogs, provider registry, router, and Settings data.
3. Instantiate the official Alibaba Model Studio OpenAI-compatible provider at
   the US endpoint and wire `/models` validation/discovery with safe fallback.
4. Replace placeholder provider tiles with a local audited official SVG
   registry shared by provider and connector views.
5. Run focused GREEN suites, TypeScript, production build, formatting, diff
   checks, and an added-line secret scan; record exact evidence and release
   owned paths.
