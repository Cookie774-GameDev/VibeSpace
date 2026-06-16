# Hive Pipeline Simulation Tiers

**Status:** Confirmed from the June 2026 VibeBench simulation  
**Source:** `hive-simulation-2026-06.json` from commit `4c82d1a`  
**Scope:** App chat Hive only. Terminals, PSTN voice, and SMS are excluded.

---

## Executive Answer

Yes, the strongest simulated Hive pipeline is the **Agent/tools Hive**:

```text
Grok 4.3 X High -> Claude Opus 4.8 -> GPT-5.5 Codex -> Gemini 3.5 Flash
```

It scored **94.4 VibeScore**, beating:

| Baseline | Score | Delta |
|---|---:|---:|
| Claude Fable 5 single model | 90.7 | +3.7 |
| Claude Opus 4.8 single model | 90.4 | +4.0 |
| GPT-5.5 single model | 89.6 | +4.8 |
| GPT-5.5 Codex single model | 89.1 | +5.3 |

**Important caveat:** this is a deterministic simulation from the VibeBench model matrix, not a fresh live-provider benchmark. It is still the best confirmed result we have in the repo.

---

## What Was Simulated

The simulation compared single frontier models against multi-step Hive topologies.

| Item | Value |
|---|---|
| Simulation timestamp | `2026-06-15T13:03:45.484Z` |
| Roster date | `2026-06-15` |
| Baseline to beat | Claude Fable 5 single model |
| Fable 5 score | 90.7 |
| Opus 4.8 score | 90.4 |
| Pipelines beating Fable 5 | 6 |
| Pipelines beating Opus 4.8 | 7 |

Methodology summary:

- Weighted VibeBench categories.
- Per-step role contribution.
- Synergy bonus: `+1.2` for 3-step pipelines.
- Synergy bonus: `+1.8` for 4+ step pipelines.
- Roster: Opus 4.8, GPT-5.5, GPT-5.5 Codex, Gemini 3.5 Flash, Grok 4.3 X High, DeepSeek V4 Pro, Qwen 3.7 Max, Kimi K2.6.
- Fable 5 was marked suspended, so Opus 4.8 was used as the practical security fallback.

---

## Confirmed Top Rankings

| Rank | Pipeline | VibeScore | Beats Fable 5 | Beats Opus 4.8 | Steps | Est. cost |
|---:|---|---:|---:|---:|---:|---:|
| 1 | Agent/tools Hive | **94.4** | +3.7 | +4.0 | 4 | $0.160 |
| 2 | Frontier 5-step Ultra | **94.1** | +3.4 | +3.7 | 5 | $0.217 |
| 3 | Frontier 4-step | **93.9** | +3.2 | +3.5 | 4 | $0.157 |
| 4 | Frontier 6-step Max | **93.8** | +3.1 | +3.4 | 6 | $0.220 |
| 5 | Code Specialist | **92.3** | +1.6 | +1.9 | 4 | $0.211 |
| 6 | Research Hive | **90.9** | +0.2 | +0.5 | 4 | $0.119 |

Conclusion:

- The **strongest confirmed general stack** is **Agent/tools Hive**.
- The **strongest max-depth stack** is **Frontier 5-step Ultra** by score, slightly below rank 1.
- The **strongest code stack** is **Code Specialist**.
- The **strongest research stack** is **Research Hive**, but it barely beats Fable 5.

---

## Recommended Product Tiers

These are the recommended Hive tiers for product use. The names map to user-facing modes.

| Tier | Goal | Fable-beating? | Recommended use |
|---|---|---:|---|
| Hive Fast | Best speed while staying high quality | No confirmed Fable beat | Everyday answers |
| Hive Balanced | Stronger than single cheap models, lower cost than Quality | Not guaranteed | Product work, drafts, normal coding |
| Hive Quality | Confirmed Fable-beating default | Yes | Hard questions, agent work, premium chat |
| Hive Ultra | Maximum frontier reliability | Yes | Supernova / highest-cost tasks |

**Key rule:** if the goal is specifically “stronger than Fable 5,” do not promise that for 1-step or 2-step Fast modes. The confirmed Fable-beating stacks in the simulation are all 4+ steps.

---

## Hive Fast

Fast is optimized for low latency and low cost. It is not the strongest tier.

### Recommended Fast Pipeline

```text
Gemini 3.5 Flash -> Opus 4.8 quick check
```

| Step | Role | Model | Reason |
|---:|---|---|---|
| 1 | Draft | `gemini-3.5-flash` | Fast, cheap, high latency score |
| 2 | Check | `claude-opus-4-8` | Catches reasoning and safety issues |

### Why not single Gemini only?

The historical `Fast v2` simulation was:

```text
Gemini 3.5 Flash only
```

| Pipeline | VibeScore | vs Fable 5 |
|---|---:|---:|
| Fast v2 single Gemini | 78.0 | -12.7 |

That is good for speed, but not competitive with Fable 5. The upgraded Fast version adds Opus as a quick check because single Gemini is not enough.

### Fast tier verdict

| Item | Status |
|---|---|
| Best for | quick chat, summaries, low-cost answers |
| Expected quality | good |
| Fable-beating confirmed | No |
| Recommended default for free/low-cost plans | Yes |

---

## Hive Balanced

Balanced should be a middle path: much stronger than Fast, cheaper than Quality.

### Recommended Balanced Pipeline

```text
Grok 4.3 X High -> Opus 4.8 -> Gemini 3.5 Flash
```

| Step | Role | Model | Reason |
|---:|---|---|---|
| 1 | Orient | `grok-4.3` with `reasoning_effort: high` | Good tool/realtime orientation |
| 2 | Draft | `claude-opus-4-8` | Best single reasoning baseline available |
| 3 | Polish | `gemini-3.5-flash` | Fast final cleanup |

### Why this Balanced version?

The old simulated Balanced v2 was:

```text
DeepSeek V4 Flash -> Opus 4.8
```

| Pipeline | VibeScore | vs Fable 5 |
|---|---:|---:|
| Balanced v2 | 84.9 | -5.8 |

That was too weak for the new goal. The recommended Balanced version borrows the key strengths of the winning stack but removes Codex to reduce latency and cost.

### Balanced tier verdict

| Item | Status |
|---|---|
| Best for | normal paid chat, practical product work |
| Expected quality | high |
| Fable-beating confirmed | Not directly confirmed |
| Why use it | likely much stronger than old Balanced, cheaper than Quality |

---

## Hive Quality

Quality is the recommended Fable-beating default.

### Confirmed Quality Pipeline

```text
Grok 4.3 X High -> Claude Opus 4.8 -> GPT-5.5 Codex -> Gemini 3.5 Flash
```

This is the rank #1 simulation.

| Step | Role | Model | Reason |
|---:|---|---|---|
| 1 | Tools / orient | `grok-4.3` with `reasoning_effort: high` | Strong tool and context orientation |
| 2 | Reason / draft | `claude-opus-4-8` | Highest practical reasoning baseline |
| 3 | Harden / code / terminal | `gpt-5.5-codex` | Strong correctness and implementation review |
| 4 | Polish / final | `gemini-3.5-flash` | Fast final compression and clarity |

### Confirmed score

| Metric | Value |
|---|---:|
| VibeScore | **94.4** |
| vs Fable 5 | **+3.7** |
| vs Opus 4.8 | **+4.0** |
| Step count | 4 |
| Estimated cost | $0.160 |

### Category scores

| Category | Score |
|---|---:|
| HiveQuality | 89.1 |
| TerminalAware | 94.6 |
| ToolActions | 90.7 |
| CodeCorrect | 95.6 |
| Security | 92.0 |
| Latency | 92.0 |
| CostEfficiency | 100.0 |

### Quality tier verdict

| Item | Status |
|---|---|
| Best for | premium chat, agentic tasks, app work |
| Expected quality | strongest confirmed |
| Fable-beating confirmed | Yes |
| Recommended paid default | Yes |

---

## Hive Ultra

Ultra is for highest reliability when cost and latency are acceptable.

### Recommended Ultra Pipeline

```text
Opus 4.8 -> DeepSeek V4 Pro -> GPT-5.5 Codex -> Opus 4.8 security -> Gemini 3.5 Flash
```

This is the rank #2 simulation.

| Step | Role | Model | Reason |
|---:|---|---|---|
| 1 | Plan | `claude-opus-4-8` | Deep reasoning and architecture |
| 2 | Implement | `deepseek-v4-pro` | Strong cost-efficient implementation |
| 3 | Harden | `gpt-5.5-codex` | Code and terminal correctness |
| 4 | Security | `claude-opus-4-8` | Final risk and safety pass |
| 5 | Ship polish | `gemini-3.5-flash` | Fast final cleanup |

### Confirmed score

| Metric | Value |
|---|---:|
| VibeScore | **94.1** |
| vs Fable 5 | **+3.4** |
| vs Opus 4.8 | **+3.7** |
| Step count | 5 |
| Estimated cost | $0.217 |

### Ultra tier verdict

| Item | Status |
|---|---|
| Best for | Supernova, critical code, release work |
| Expected quality | near best |
| Fable-beating confirmed | Yes |
| Tradeoff | higher latency and cost than Quality |

---

## Task-Specific Recommendations

### Code

Use the confirmed Code Specialist stack:

```text
Opus 4.8 -> DeepSeek V4 Pro -> GPT-5.5 Codex -> Opus 4.8 security
```

| Metric | Value |
|---|---:|
| VibeScore | 92.3 |
| vs Fable 5 | +1.6 |
| vs Opus 4.8 | +1.9 |
| Estimated cost | $0.211 |

### Agent / tool workflows

Use the confirmed rank #1 stack:

```text
Grok 4.3 X High -> Opus 4.8 -> GPT-5.5 Codex -> Gemini 3.5 Flash
```

| Metric | Value |
|---|---:|
| VibeScore | 94.4 |
| vs Fable 5 | +3.7 |
| vs Opus 4.8 | +4.0 |

### Research

Use the confirmed Research stack:

```text
Gemini 3.1 Pro -> Opus 4.8 -> Grok 4.3 X High -> Qwen 3.7 Max
```

| Metric | Value |
|---|---:|
| VibeScore | 90.9 |
| vs Fable 5 | +0.2 |
| vs Opus 4.8 | +0.5 |

Research barely beats Fable 5 in the simulation, so it should be treated as a specialized stack, not the general strongest default.

---

## Final Recommendation

Use this product mapping:

| Product mode | Pipeline | Confirmed score |
|---|---|---:|
| Fast | Gemini 3.5 Flash -> Opus quick check | Not historically scored |
| Balanced | Grok X High -> Opus -> Gemini Flash | Not historically scored |
| Quality | Grok X High -> Opus -> Codex -> Gemini Flash | **94.4** |
| Ultra | Opus -> DeepSeek V4 Pro -> Codex -> Opus security -> Gemini Flash | **94.1** |

If only one pipeline can be the default for “stronger than Fable 5,” choose **Hive Quality**:

```text
Grok 4.3 X High -> Claude Opus 4.8 -> GPT-5.5 Codex -> Gemini 3.5 Flash
```

Reason:

- Highest confirmed score.
- Beats Fable 5 by +3.7.
- Beats Opus 4.8 by +4.0.
- Lower cost than the 5-step Ultra pipeline.
- Strongest combined performance across tool use, code correctness, and terminal-aware work.

---

## Confirmation Status

| Claim | Status |
|---|---|
| Rank #1 stack beats Fable 5 | Confirmed by VibeBench simulation |
| Rank #1 stack beats Opus 4.8 | Confirmed by VibeBench simulation |
| 6 pipelines beat Fable 5 | Confirmed by VibeBench simulation |
| 1-step Fast beats Fable 5 | Not confirmed |
| 2-step Balanced beats Fable 5 | Not confirmed |
| Live API benchmark against real providers | Not run in current tree |

The correct wording is:

> “Hive Quality is the strongest confirmed simulated pipeline and beats the Fable 5 single-model baseline in the June 2026 VibeBench simulation.”

Do not word it as:

> “Hive is guaranteed to beat Fable 5 on every live request.”

That would be too strong, because live model quality depends on provider behavior, prompts, tool availability, rate limits, and task category.

