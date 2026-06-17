import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Sparkles,
  Trash2,
  Zap,
  Globe,
  Server,
  Cloud,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { ProviderId } from '@/types/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  isDefaultProviderSelectable,
  planIncludesHostedChat,
} from '@/lib/ai/agentProviderOptions';
import { testProviderKey } from '@/lib/ai/testKey';
import {
  getMonthlyAllProviderUsage,
  type LocalUsageTotals,
} from '@/lib/usage/usageSummary';
import { ProviderUsageCounter, type ProviderUsageData } from '../components/ProviderUsageCounter';

interface ProviderRow {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
  freeKeyUrl?: string;
  freeKeyLabel?: string;
  baseUrlField?: boolean;
  category: 'major' | 'inference' | 'gateway' | 'enterprise' | 'local';
  color: string;
}

const BYOK_PROVIDERS: ProviderRow[] = [
  // Major cloud providers
  {
    id: 'anthropic',
    name: 'Anthropic',
    hint: 'Claude Opus / Sonnet / Haiku',
    placeholder: 'sk-ant-...',
    category: 'major',
    color: 'from-orange-500/20 to-amber-500/20',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: 'GPT-5, o3, embeddings, realtime',
    placeholder: 'sk-...',
    category: 'major',
    color: 'from-emerald-500/20 to-teal-500/20',
  },
  {
    id: 'google',
    name: 'Gemini',
    hint: 'Gemini 2.5 Flash/Pro (free tier available)',
    placeholder: 'AIza...',
    freeKeyUrl: 'https://aistudio.google.com/apikey',
    freeKeyLabel: 'Get a free key',
    category: 'major',
    color: 'from-blue-500/20 to-indigo-500/20',
  },
  // Fast inference providers
  {
    id: 'groq',
    name: 'Groq',
    hint: 'Llama 3.3 70B, sub-second TTFT, free tier',
    placeholder: 'gsk_...',
    freeKeyUrl: 'https://console.groq.com/keys',
    freeKeyLabel: 'Get a free key (no card)',
    category: 'inference',
    color: 'from-purple-500/20 to-pink-500/20',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    hint: 'Ultra-fast Llama inference on wafer-scale chips',
    placeholder: 'csk-...',
    freeKeyUrl: 'https://cloud.cerebras.ai/',
    freeKeyLabel: 'Get started',
    category: 'inference',
    color: 'from-cyan-500/20 to-blue-500/20',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    hint: 'Fast inference for open-source weights',
    placeholder: 'fw_...',
    category: 'inference',
    color: 'from-orange-500/20 to-red-500/20',
  },
  {
    id: 'together',
    name: 'Together AI',
    hint: 'Llama / Qwen / Mixtral open weights',
    placeholder: 'tgp_...',
    category: 'inference',
    color: 'from-violet-500/20 to-purple-500/20',
  },
  // Specialized providers
  {
    id: 'xai',
    name: 'xAI',
    hint: 'Grok family',
    placeholder: 'xai-...',
    category: 'inference',
    color: 'from-slate-500/20 to-gray-500/20',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: 'DeepSeek V3 / Coder / R1',
    placeholder: 'sk-...',
    category: 'inference',
    color: 'from-sky-500/20 to-cyan-500/20',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    hint: 'Mistral Large / Medium / Codestral',
    placeholder: 'mistral-...',
    category: 'inference',
    color: 'from-amber-500/20 to-yellow-500/20',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    hint: 'Command R+ with strong RAG & multilingual',
    placeholder: '...',
    category: 'inference',
    color: 'from-rose-500/20 to-pink-500/20',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hint: 'Online models with built-in web search',
    placeholder: 'pplx-...',
    category: 'inference',
    color: 'from-teal-500/20 to-emerald-500/20',
  },
  // Gateway providers
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'Multi-model gateway (200+ models)',
    placeholder: 'sk-or-...',
    category: 'gateway',
    color: 'from-fuchsia-500/20 to-purple-500/20',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    hint: 'Open-source models on cloud GPU',
    placeholder: 'r8_...',
    category: 'gateway',
    color: 'from-indigo-500/20 to-blue-500/20',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    hint: 'Inference API for HF models',
    placeholder: 'hf_...',
    freeKeyUrl: 'https://huggingface.co/settings/tokens',
    freeKeyLabel: 'Get token',
    category: 'gateway',
    color: 'from-yellow-500/20 to-orange-500/20',
  },
  // Enterprise providers
  {
    id: 'azure',
    name: 'Azure OpenAI',
    hint: 'Azure-hosted OpenAI models',
    placeholder: '...',
    baseUrlField: true,
    category: 'enterprise',
    color: 'from-blue-600/20 to-cyan-500/20',
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    hint: 'Claude, Llama, Titan on AWS',
    placeholder: 'Access key...',
    baseUrlField: true,
    category: 'enterprise',
    color: 'from-orange-600/20 to-amber-500/20',
  },
  // Other inference
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    hint: 'OpenAI-compatible open-source inference',
    placeholder: '...',
    category: 'inference',
    color: 'from-lime-500/20 to-green-500/20',
  },
  {
    id: 'novita',
    name: 'Novita',
    hint: 'Cheap Llama / DeepSeek / Qwen inference',
    placeholder: 'sk_...',
    category: 'inference',
    color: 'from-pink-500/20 to-rose-500/20',
  },
  {
    id: 'lambda',
    name: 'Lambda',
    hint: 'Lambda AI Cloud (OpenAI-compatible)',
    placeholder: 'secret_...',
    category: 'inference',
    color: 'from-violet-600/20 to-indigo-500/20',
  },
  // Local
  {
    id: 'ollama',
    name: 'Ollama (local)',
    hint: 'Local model server (no key needed)',
    placeholder: 'http://localhost:11434',
    category: 'local',
    color: 'from-slate-400/20 to-zinc-500/20',
  },
];

const CATEGORY_META: Record<ProviderRow['category'], { label: string; icon: typeof Cloud }> = {
  major: { label: 'Major Cloud Providers', icon: Cloud },
  inference: { label: 'Fast Inference', icon: Zap },
  gateway: { label: 'Model Gateways', icon: Globe },
  enterprise: { label: 'Enterprise', icon: Server },
  local: { label: 'Local', icon: Server },
};

const BYOK_PROVIDER_IDS = BYOK_PROVIDERS.map((provider) => provider.id);

const DEFAULT_PROVIDER_OPTIONS: { id: ProviderId; label: string; description: string }[] = [
  { id: 'anthropic', label: 'Anthropic', description: 'Best for reasoning and writing.' },
  { id: 'openai', label: 'OpenAI', description: 'Strong generalist with realtime voice.' },
  { id: 'google', label: 'Gemini', description: 'Long context, fast Flash tier.' },
  { id: 'groq', label: 'Groq', description: 'Sub-second open-weights inference.' },
  { id: 'deepseek', label: 'DeepSeek', description: 'DeepSeek V4 Flash via subscription credits.' },
  { id: 'ollama', label: 'Ollama (local)', description: 'Local models on this device.' },
  { id: 'xai', label: 'xAI', description: 'Grok models with strong reasoning.' },
  { id: 'openrouter', label: 'OpenRouter', description: 'Single key, hundreds of models.' },
  { id: 'mock', label: 'Mock', description: 'Built-in placeholder. No network calls.' },
];

export function Providers() {
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const clearApiKey = useAuthStore((s) => s.clearApiKey);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);
  const plan = useAuthStore((s) => s.plan);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const usageByProvider = useLiveQuery(async () => {
    const totals = await getMonthlyAllProviderUsage(BYOK_PROVIDER_IDS);
    return BYOK_PROVIDERS.reduce<Partial<Record<ProviderId, ProviderUsageData | null>>>(
      (acc, provider) => {
        acc[provider.id] = toProviderUsageData(totals[provider.id] ?? emptyUsageTotals());
        return acc;
      },
      {},
    );
  }, []);

  const groupedProviders = useMemo(() => {
    const groups: Record<ProviderRow['category'], ProviderRow[]> = {
      major: [],
      inference: [],
      gateway: [],
      enterprise: [],
      local: [],
    };
    for (const p of BYOK_PROVIDERS) {
      groups[p.category].push(p);
    }
    return groups;
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h2 className="text-page-title text-foreground">Providers</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Bring your own keys. Stored locally and never leave this device until you make a request.
        </p>
        <div className="flex items-center gap-2 mt-3">
          <Badge variant="outline" className="text-metadata">
            {BYOK_PROVIDERS.length} providers
          </Badge>
          <Badge variant="outline" className="text-metadata text-sage">
            {Object.values(apiKeys).filter(Boolean).length} connected
          </Badge>
        </div>
      </header>

      {/* Provider sections by category */}
      {(['major', 'inference', 'gateway', 'enterprise', 'local'] as const).map((category) => {
        const providers = groupedProviders[category];
        if (providers.length === 0) return null;
        const meta = CATEGORY_META[category];
        const Icon = meta.icon;

        return (
          <section key={category} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-accent-copper" />
              <h3 className="text-ui-strong text-foreground">{meta.label}</h3>
              <Badge variant="outline" className="text-metadata ml-auto">
                {providers.length}
              </Badge>
            </div>
            <div className="grid gap-3">
              {providers.map((p) => (
                <ProviderKeyRow
                  key={p.id}
                  row={p}
                  value={apiKeys[p.id] ?? ''}
                  onSave={(v) => setApiKey(p.id, v)}
                  onClear={() => clearApiKey(p.id)}
                  usageData={usageByProvider?.[p.id] ?? null}
                />
              ))}
            </div>
          </section>
        );
      })}

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui-strong text-foreground">Default provider</h3>
          <p className="text-secondary text-muted-foreground">
            Used when a chat doesn't pin a model.
          </p>
        </div>
        <div role="radiogroup" aria-label="Default provider" className="grid gap-2 max-w-xl">
          {DEFAULT_PROVIDER_OPTIONS.map((opt) => {
            const selected = defaultProvider === opt.id;
            const selectable = isDefaultProviderSelectable(opt.id, apiKeys, offlineMode, plan, defaultLocalModel);
            const hasKey = opt.id === 'mock' ? Boolean(apiKeys.mock?.trim()) : Boolean(apiKeys[opt.id]?.trim());
            const subscriptionHosted =
              planIncludesHostedChat(plan) && (opt.id === 'google' || opt.id === 'deepseek');
            return (
              <button
                type="button"
                key={opt.id}
                role="radio"
                aria-checked={selected}
                disabled={!selectable}
                onClick={() => {
                  if (!selectable) return;
                  setDefaultProvider(opt.id);
                }}
                className={cn(
                  'flex items-center gap-3 rounded-md border bg-panel px-3 py-2 text-left transition-all duration-200',
                  'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  !selectable && 'opacity-50 cursor-not-allowed hover:bg-panel',
                  selected
                    ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.3)]'
                    : 'border-border',
                )}
              >
                <span
                  className={cn(
                    'h-3.5 w-3.5 rounded-full border flex items-center justify-center shrink-0',
                    selected
                      ? 'border-transparent bg-accent-gradient'
                      : 'border-border-mid bg-background',
                  )}
                >
                  {selected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-ui-strong text-foreground">{opt.label}</span>
                    {subscriptionHosted && !hasKey && (
                      <Badge variant="outline" className="text-sage">
                        Subscription
                      </Badge>
                    )}
                    {!hasKey && opt.id !== 'mock' && opt.id !== 'ollama' && !subscriptionHosted && (
                      <Badge variant="outline">No key</Badge>
                    )}
                    {!selectable && <Badge variant="outline">Unavailable</Badge>}
                  </span>
                  <span className="text-metadata text-muted-foreground block">
                    {opt.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

interface ProviderKeyRowProps {
  row: ProviderRow;
  value: string;
  onSave: (value: string) => void;
  onClear: () => void;
  usageData: ProviderUsageData | null;
}

function emptyUsageTotals(): LocalUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    calls: 0,
    lastUsed: null,
  };
}

function toProviderUsageData(totals: LocalUsageTotals): ProviderUsageData | null {
  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cachedTokens;
  if (totals.calls === 0 && totalTokens === 0) return null;
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    totalTokens,
    costUsd: totals.costUsd,
    lastUsed: totals.lastUsed,
  };
}

const ProviderKeyRow = memo(function ProviderKeyRow({ row, value, onSave, onClear, usageData }: ProviderKeyRowProps) {
  const [draft, setDraft] = useState(value);
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
    if (!value) setRevealed(false);
  }, [value]);

  const dirty = draft !== value;
  const isSaved = !!value;

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setRevealed(false);
    toast.success(`${row.name} key saved`, 'Stored locally on this device.');
  }

  function handleTest() {
    const key = draft.trim();
    if (!key && row.id !== 'ollama') {
      toast.warning('No key to test', `Enter a ${row.name} key first.`);
      return;
    }
    setTesting(true);
    void (async () => {
      try {
        const result = await testProviderKey(row.id, key);
        switch (result.kind) {
          case 'ok':
            toast.success(
              `${row.name} key works`,
              result.detail ?? 'Provider responded successfully.',
            );
            break;
          case 'invalid':
            toast.error(
              `${row.name} rejected the key`,
              result.detail || 'The provider returned an authentication error.',
            );
            break;
          case 'network':
            toast.warning(
              `Couldn't reach ${row.name}`,
              row.id === 'ollama'
                ? 'Is the Ollama daemon running? Start it and try again.'
                : `${result.detail}. Check your internet or proxy.`,
            );
            break;
          case 'unconfigured':
            toast.warning('No key entered');
            break;
          case 'unsupported':
            toast.info(
              `${row.name} live validation pending`,
              'The key is saved; live validation lands when its adapter does.',
            );
            break;
        }
      } catch (err) {
        toast.error(`${row.name} test failed`, (err as Error).message);
      } finally {
        setTesting(false);
      }
    })();
  }

  function handleClear() {
    onClear();
    setDraft('');
    setRevealed(false);
    toast.info(`${row.name} key removed`);
  }

  async function handleCopy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  }

  return (
    <motion.div
      initial={false}
      animate={{
        borderColor: isSaved
          ? 'hsl(var(--accent-copper) / 0.3)'
          : focused
            ? 'hsl(var(--accent-copper) / 0.5)'
            : 'hsl(var(--border))',
      }}
      className={cn(
        'jarvis-provider-key-card relative rounded-lg border p-4 transition-all duration-300',
        isSaved && 'shadow-[0_0_20px_-5px_hsl(var(--accent-copper)/0.2)]',
      )}
    >
      {/* Ambient glow for saved providers */}
      {isSaved && (
        <div
          className="absolute inset-0 rounded-lg opacity-30 pointer-events-none"
          style={{
            background: `radial-gradient(circle at 20% 20%, hsl(var(--accent-copper) / 0.15), transparent 50%)`,
          }}
        />
      )}

      <div className="relative flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <Label
              htmlFor={`key-${row.id}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span className="text-ui-strong text-foreground">{row.name}</span>
              <span className="text-metadata text-muted-foreground font-normal">{row.hint}</span>
            </Label>
            {row.freeKeyUrl && (
              <a
                href={row.freeKeyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-metadata text-accent-copper hover:text-accent-amber transition-colors mt-1"
              >
                <ExternalLink className="h-3 w-3" />
                {row.freeKeyLabel ?? 'Get a free key'}
              </a>
            )}
          </div>
          <AnimatePresence mode="wait">
            {isSaved ? (
              <motion.div
                key="saved"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                <Badge variant="success" className="gap-1">
                  <Check className="h-3 w-3" />
                  Connected
                </Badge>
              </motion.div>
            ) : dirty && draft.trim() ? (
              <motion.div
                key="unsaved"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                <Badge variant="outline" className="text-honey">
                  Unsaved
                </Badge>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Input row */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1" data-jarvis-rainbow="true" data-jarvis-api-key="true">
            <Input
              ref={inputRef}
              id={`key-${row.id}`}
              type={revealed ? 'text' : 'password'}
              placeholder={row.placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
              className={cn(
                'pr-20 font-mono transition-all duration-200',
                focused && 'ring-2 ring-accent-copper/30',
              )}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {isSaved && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className={cn(
                    'p-1 rounded text-muted-foreground hover:text-foreground transition-colors',
                    copied && 'text-sage',
                  )}
                  aria-label="Copy key"
                  tabIndex={-1}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                aria-label={revealed ? 'Hide key' : 'Show key'}
                tabIndex={-1}
              >
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || !draft.trim()}
            className="transition-all duration-200 hover:bg-accent-copper/20"
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            className="gap-1"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {testing ? 'Testing...' : 'Test'}
          </Button>
          {isSaved && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleClear}
              aria-label="Remove key"
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Usage counter */}
        <ProviderUsageCounter providerId={row.id} usage={usageData} className="mt-1" />
      </div>
    </motion.div>
  );
});
