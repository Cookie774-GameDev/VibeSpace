# Benchmark Scout — AI News Integration

This PR 31 feature connects the free hourly Cloudflare AI News output to the existing VibeSpace Benchmarks page.

## Behavior

- Reads `VITE_NEWS_API_URL` and requests `/api/news?category=model-release&limit=40`.
- Accepts only `official` or `confirmed` model-release items with a recognizable model name.
- Places the newest detected model in **Position 1**.
- Uses an exact real leaderboard row when one exists.
- Otherwise labels Position 1 as **Benchmark pending — no score invented**.
- Places a real same-family model in **Position 2** when possible.
- Falls back to a same-provider model, then the actual leaderboard leader.
- Keeps the last successful comparison for up to 24 hours when the news endpoint is temporarily unavailable.
- Refreshes only while the Benchmarks route is mounted, at a restrained 15-minute interval, plus manual refresh.

No paid AI call is required. Detection, matching, and comparison selection are deterministic so the system remains free.

## Setup

Deploy the existing Worker, then set the permanent Worker origin in `app/.env.local`:

```text
VITE_NEWS_API_URL=https://vibespace-ai-news.<account-subdomain>.workers.dev
```

Do not include `/api/news` in the environment value and do not commit `.env.local`.

## Truthfulness rules

- News never creates or modifies leaderboard scores.
- A model without a real benchmark row remains pending.
- `confirmed` media aggregation is never presented as official company news.
- The second position always comes from the existing benchmark dataset.
