#!/usr/bin/env node
/**
 * VibeBench local runner — BYOK batch against suite/manifest.json.
 *
 * Usage:
 *   node scripts/vibebench-run.mjs
 *   node scripts/vibebench-run.mjs --models anthropic:claude-opus-4-8,openai:gpt-5.5,google:gemini-3.5-flash
 *
 * Env keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY / GEMINI_API_KEY,
 *           DEEPSEEK_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY, MISTRAL_API_KEY
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST = join(ROOT, 'benchmarks/vibebench/suite/manifest.json');
const RESULTS_DIR = join(ROOT, 'benchmarks/vibebench/results');

const ENDPOINTS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: () => process.env.OPENAI_API_KEY },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', key: () => process.env.ANTHROPIC_API_KEY, anthropic: true },
  google: { url: (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, key: () => process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY, google: true },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', key: () => process.env.DEEPSEEK_API_KEY },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: () => process.env.GROQ_API_KEY },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', key: () => process.env.MISTRAL_API_KEY },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: () => process.env.OPENROUTER_API_KEY },
  xai: { url: 'https://api.x.ai/v1/chat/completions', key: () => process.env.XAI_API_KEY },
};

function parseArgs() {
  const modelsArg = process.argv.find((a) => a.startsWith('--models='))?.slice(9)
    ?? process.argv[process.argv.indexOf('--models') + 1];
  return { modelsArg };
}

function parseModels(manifest, modelsArg) {
  if (!modelsArg) return manifest.default_models.slice(0, 2);
  return modelsArg.split(',').map((pair) => {
    const [provider, model] = pair.trim().split(':');
    return { provider, model, label: `${provider}/${model}` };
  });
}

async function callModel(provider, model, prompt, maxTokens = 1024) {
  const cfg = ENDPOINTS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const apiKey = cfg.key();
  if (!apiKey) throw new Error(`Missing API key for ${provider}`);

  const started = Date.now();

  if (cfg.anthropic) {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    const text = data.content?.map((b) => b.text).join('') ?? '';
    const outTok = data.usage?.output_tokens ?? estimateTokens(text);
    return { text, latencyMs: Date.now() - started, outputTokens: outTok };
  }

  if (cfg.google) {
    const url = `${cfg.url(model)}?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return { text, latencyMs: Date.now() - started, outputTokens: estimateTokens(text) };
  }

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  const text = data.choices?.[0]?.message?.content ?? '';
  const outTok = data.usage?.completion_tokens ?? estimateTokens(text);
  return { text, latencyMs: Date.now() - started, outputTokens: outTok };
}

function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

function scoreDeterministic(text, deterministic) {
  if (!deterministic?.must_include?.length) return null;
  const lower = text.toLowerCase();
  const hits = deterministic.must_include.filter((s) => lower.includes(s.toLowerCase()));
  return Math.round((hits.length / deterministic.must_include.length) * 100);
}

function scoreLatency(outputTokens, latencyMs) {
  if (!latencyMs || latencyMs <= 0) return 0;
  const tps = (outputTokens / latencyMs) * 1000;
  return Math.min(100, Math.round(tps * 3));
}

function categoryScore(promptResults, category) {
  const rows = promptResults.filter((r) => r.category === category);
  if (rows.length === 0) return 0;
  const sum = rows.reduce((a, r) => a + (r.score ?? 0), 0);
  return sum / rows.length;
}

function computeVibeScore(categoryScores, weights) {
  let total = 0;
  for (const [cat, w] of Object.entries(weights)) {
    total += (categoryScores[cat] ?? 0) * w;
  }
  return Math.round(total * 10) / 10;
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const { modelsArg } = parseArgs();
  const models = parseModels(manifest, modelsArg);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  console.log(`VibeBench ${manifest.version} — run ${runId}`);
  console.log(`Models: ${models.map((m) => m.label ?? m.model).join(', ')}`);

  const modelResults = [];

  for (const target of models) {
    const promptResults = [];
    let totalCostUsd = 0;

    for (const p of manifest.prompts) {
      const fullPrompt = p.terminal_context
        ? `${p.terminal_context}\n\nUser question: ${p.prompt}`
        : p.prompt;
      try {
        const { text, latencyMs, outputTokens } = await callModel(
          target.provider,
          target.model,
          fullPrompt,
          p.max_output_tokens ?? 1024,
        );
        let score = scoreDeterministic(text, p.deterministic);
        if (score == null && p.category === 'Latency') {
          score = scoreLatency(outputTokens, latencyMs);
        } else if (score == null) {
          score = text.trim().length > 20 ? 70 : 30;
        }
        promptResults.push({
          prompt_id: p.id,
          category: p.category,
          score,
          latency_ms: latencyMs,
          output_tokens: outputTokens,
          text_preview: text.slice(0, 200),
        });
        totalCostUsd += 0.002;
      } catch (err) {
        promptResults.push({
          prompt_id: p.id,
          category: p.category,
          score: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const categoryScores = {};
    for (const cat of Object.keys(manifest.category_weights)) {
      if (cat === 'CostEfficiency') continue;
      categoryScores[cat] = categoryScore(promptResults, cat);
    }
    let vibeScore = computeVibeScore(categoryScores, manifest.category_weights);
    const costEff = Math.min(100, (vibeScore / Math.max(totalCostUsd, 0.001)) * 0.01);
    categoryScores.CostEfficiency = costEff;
    vibeScore = computeVibeScore(categoryScores, manifest.category_weights);

    modelResults.push({
      provider: target.provider,
      model: target.model,
      label: target.label ?? target.model,
      vibe_score: vibeScore,
      category_scores: categoryScores,
      cost_usd: totalCostUsd,
      prompts: promptResults,
    });
    console.log(`  ${target.model}: VibeScore ${vibeScore}`);
  }

  const payload = {
    run_id: runId,
    suite_version: manifest.version,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    models: modelResults,
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
