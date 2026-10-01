# Qwen Provider and Official Provider Brands Design

## Goal

Make Qwen a first-class VibeSpace BYOK chat provider and replace fabricated
provider marks with current official brand artwork without changing existing
provider behavior.

## Qwen architecture

Qwen uses Alibaba Model Studio's official OpenAI-compatible US endpoint:
`https://dashscope-us.aliyuncs.com/compatible-mode/v1`. Its API key is stored
through the existing secure-key vault, requests flow through the shared
OpenAI-compatible streaming provider, and live key validation plus model
discovery use the endpoint's `/models` resource. The existing Qwen CLI
connection remains a separate local connector.

The static fallback catalog contains active, documented Qwen 3.7 and 3.6
aliases/snapshots plus Qwen Coder Next. Dynamic discovery replaces the fallback
with models actually available to the connected account when the API responds.
Missing keys, rejected credentials, network errors, and empty discovery results
reuse the existing provider error/fallback behavior.

## Brand architecture

`ConnectorBrandMark` remains the shared renderer. A centralized local registry
stores audited official SVG geometry, view boxes, brand colors, and accessible
names. Normal appearances use official brand color; MonoChrome uses the same
official silhouette through the current-color appearance treatment. No logo is
downloaded at runtime and no initials/text tile is presented as a provider
logo. Providers without a standalone product glyph use their official parent
company mark with a truthful accessible label.

## Scope and safety

No dependencies, billing configuration, credentials, cloud state, routes, or
unrelated settings are changed. Existing provider IDs and provider-specific
request implementations remain unchanged.

## Verification

Focused tests prove Qwen model visibility, secure-key enrollment, endpoint
routing, streaming, key validation, live discovery, Settings enrollment, and
official non-placeholder marks for every provider shown by the shared
connector surface. TypeScript and the production build provide integration
coverage.
