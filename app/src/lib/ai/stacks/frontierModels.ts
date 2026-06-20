export const HIVE_FRONTIER_MODELS = {
  anthropic_opus: 'claude-opus-4-8',
  anthropic_fable: 'claude-fable-5',
  openai_flagship: 'gpt-5.5',
  openai_flagship_pro: 'gpt-5.5-pro',
  openai_coding: 'gpt-5.5-codex',
  google_flash: 'gemini-3.5-flash',
  google_pro: 'gemini-3.1-pro',
  grok: 'grok-4.3',
  deepseek_pro: 'deepseek-v4-pro',
  deepseek_flash: 'deepseek-v4-flash',
  qwen_max: 'qwen/qwen-3.7-max',
  kimi_k26: 'moonshotai/kimi-k2.6',
  perplexity_sonar: 'perplexity/sonar',
  mistral_large: 'mistral-large-latest',
  // ── Hive Balance pipeline ──────────────────────────────────────────────────
  /** Primary step: Gemini 3.5 Flash High — fast, accurate, cheap. */
  google_flash_high: 'gemini-3.5-flash-high',
  /** MiniMax-M3 — strong Chinese frontier model for cross-check. */
  minimax_m3: 'minimax/minimax-m3',
  /** GLM-5.2 — ZhipuAI's reasoning model for diverse ensemble. */
  glm_52: 'zhipuai/glm-5.2',
  /** DeepSeek V4 Pro Max — coding / reasoning harden step. */
  deepseek_pro_max: 'deepseek-v4-pro-max',
  /** GPT-5.4 mini xhigh — OpenAI lightweight final pass. */
  openai_mini_xhigh: 'gpt-5.4-mini',
} as const;

export const GROK_HIGH_REASONING_EFFORT = 'high';
