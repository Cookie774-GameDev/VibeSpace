/**
 * Pinned frontier model IDs for Vibe Hive Quality mode.
 * Update here when providers ship new SKUs; re-run VibeBench HiveQuality after changes.
 *
 * Last validated: June 15, 2026 (vibebench-2026.06)
 */
export const FRONTIER = {
  /** #1 AA Intelligence Index — agentic coding, reasoning, computer use */
  anthropic_opus: 'claude-opus-4-8',
  /**
   * Mythos-class security/audit tier. Suspended June 12, 2026 (US export-control).
   * Runtime should fall back to anthropic_opus when unavailable.
   */
  anthropic_fable: 'claude-fable-5',
  /** General flagship — terminal agents, tool use, multimodal */
  openai_flagship: 'gpt-5.5',
  openai_flagship_pro: 'gpt-5.5-pro',
  /** Codex / agentic coding endpoint */
  openai_coding: 'gpt-5.5-codex',
  /** GA May 19, 2026 — agentic loops, fast polish */
  google_flash: 'gemini-3.5-flash',
  /** Deep multimodal until gemini-3.5-pro ships (expected late June 2026) */
  google_pro: 'gemini-3.1-pro',
  /** xAI flagship — pair with reasoning_effort: "high" for X High tier */
  grok: 'grok-4.3',
  deepseek_pro: 'deepseek-v4-pro',
  deepseek_flash: 'deepseek-v4-flash',
  /** @deprecated Use deepseek_pro */
  deepseek_chat: 'deepseek-v4-pro',
  /** @deprecated Use deepseek_pro */
  deepseek_reasoner: 'deepseek-v4-pro',
  /** Qwen frontier via OpenRouter */
  qwen_max: 'qwen/qwen-3.7-max',
  /** Moonshot Kimi K2.6 via OpenRouter */
  kimi_k26: 'moonshotai/kimi-k2.6',
  /** @deprecated Use kimi_k26 */
  kimi_k2: 'moonshotai/kimi-k2.6',
  perplexity_sonar: 'perplexity/sonar',
  mistral_large: 'mistral-large-latest',
} as const;

/**
 * xAI Grok 4.3 "X High" — deepest reasoning tier.
 * Pass as providerOptions.reasoning_effort on xai stack steps.
 * grok-4.20-multi-agent also supports effort "xhigh" (16-agent mode).
 */
export const GROK_HIGH_REASONING_EFFORT = 'high' as const;

export type FrontierModelKey = keyof typeof FRONTIER;
