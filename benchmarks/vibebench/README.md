# VibeBench

VibeBench is VibeSpace's proprietary benchmark for **vibe-coding workflows** — not generic chat ELO. It measures how well frontier models perform inside the product surface: Vibe Hive pipelines, terminal context, tool actions, and code correctness.

## Suite version

`vibebench-2026.06` — frozen prompt bank in `suite/manifest.json`.

## Categories

| Category | Weight | Scoring |
|----------|--------|---------|
| HiveQuality | 25% | LLM judge rubric (1–5) |
| TerminalAware | 15% | LLM judge + context citation check |
| ToolActions | 15% | Deterministic JSON fence parse |
| CodeCorrect | 20% | Deterministic test pass (0/1) |
| Security | 10% | Regex + judge |
| Latency | 10% | p50 tok/s (normalized 0–100) |
| CostEfficiency | 5% | VibeScore / USD |

## VibeScore formula

Per model run:

```
category_score = average(prompt_scores in category)  # 0–100 scale
VibeScore = sum(weight_i * category_score_i)
```

Judge model (pinned): `claude-sonnet-4-20250514` at temperature 0.

Cost efficiency:

```
cost_efficiency = min(100, (VibeScore / max(cost_usd, 0.001)) * 0.01)
```

## Reproducibility

Every published run records:

- `suite_version`
- `git_commit` (when available)
- `run_id` (UUID)
- Raw outputs in `results/` or Supabase `vibebench_artifacts`

## Local runner

```bash
# BYOK — set keys in env, then:
node scripts/vibebench-run.mjs --models anthropic:claude-sonnet-4-20250514,openai:gpt-4o
```

Results land in `benchmarks/vibebench/results/<run_id>.json`.

## Cloud batch (funding)

`supabase/functions/vibebench-batch` — weekly sweep of top-10 frontier models via platform keys. Requires migration `0025_vibebench.sql`.

## Frontier model list (benchmark targets)

Aligned with Vibe Hive Quality `frontierModels.ts`:

1. Claude Sonnet 4
2. GPT-4o
3. Gemini 2.5 Flash / Pro
4. DeepSeek V3 / R1
5. Kimi K2 (OpenRouter)
6. Grok 3
7. Llama 3.3 70B (Groq)
8. Mistral Large
9. o4-mini
10. Perplexity Sonar (OpenRouter)
