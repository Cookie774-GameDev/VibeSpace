import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Sparkles, Trash2, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { ProviderId } from '@/types/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { testProviderKey } from '@/lib/ai/testKey';
import { fireApiKeySaveBurstFromElement } from '../ApiKeySaveBurst';

interface ProviderRow {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
  /**
   * If set, render an inline external link next to the provider name
   * pointing at the signup / dashboard URL where the user can grab a
   * free or paid key. Used today for Groq, where free Llama-3.3-70B
   * keys are 30 seconds away with no card.
   */
  freeKeyUrl?: string;
  /** Override the link text. Defaults to "Get a free key". */
  freeKeyLabel?: string;
}

const BYOK_PROVIDERS: ProviderRow[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    hint: 'Claude Opus / Sonnet / Haiku',
    placeholder: 'sk-ant-...',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: 'GPT-5, embeddings, realtime',
    placeholder: 'sk-...',
  },
  {
    id: 'google',
    name: 'Google',
    hint: 'Gemini 2.5 Flash Lite (free tier, no card)',
    placeholder: 'AIza...',
    freeKeyUrl: 'https://aistudio.google.com/apikey',
    freeKeyLabel: 'Get a free key',
  },
  // V2 — OpenAI-compatible providers. Keys persist now; live routing
  // ships when the openai-compatible adapter lands.
  {
    id: 'xai',
    name: 'xAI',
    hint: 'Grok family',
    placeholder: 'xai-...',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'Multi-model gateway',
    placeholder: 'sk-or-...',
  },
  {
    id: 'groq',
    name: 'Groq',
    hint: 'Llama 3.3 70B, sub-second TTFT, free tier',
    placeholder: 'gsk_...',
    freeKeyUrl: 'https://console.groq.com/keys',
    freeKeyLabel: 'Get a free key (no card)',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: 'DeepSeek V3 / Coder',
    placeholder: 'sk-...',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    hint: 'Mistral Large / Nemo',
    placeholder: 'mistral-...',
  },
  {
    id: 'together',
    name: 'Together AI',
    hint: 'Llama / Qwen open weights',
    placeholder: 'tgp_...',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    hint: 'Local model server (no key needed)',
    placeholder: 'http://localhost:11434',
  },
  // V3 — additional OpenAI-compatible providers.
  {
    id: 'cohere',
    name: 'Cohere',
    hint: 'Multilingual command-tier models with strong RAG',
    placeholder: '...',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hint: 'Online models with built-in web search',
    placeholder: 'pplx-...',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    hint: 'Fast inference for open-source weights',
    placeholder: 'fw_...',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    hint: 'Open-source models on cloud GPU',
    placeholder: 'r8_...',
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    hint: 'OpenAI-compatible open-source inference',
    placeholder: '...',
  },
  {
    id: 'novita',
    name: 'Novita',
    hint: 'Cheap Llama / DeepSeek / Qwen inference',
    placeholder: 'sk_...',
  },
  {
    id: 'lambda',
    name: 'Lambda',
    hint: 'Lambda AI Cloud (OpenAI-compatible)',
    placeholder: 'secret_...',
  },
];

/** All providers eligible to be picked as the default in chat. */
const DEFAULT_PROVIDER_OPTIONS: { id: ProviderId; label: string; description: string }[] = [
  { id: 'anthropic', label: 'Anthropic', description: 'Best for reasoning and writing.' },
  { id: 'openai', label: 'OpenAI', description: 'Strong generalist with realtime voice.' },
  { id: 'google', label: 'Google', description: 'Long context, fast Flash tier.' },
  { id: 'xai', label: 'xAI', description: 'Grok models. Live routing in a follow-up.' },
  { id: 'openrouter', label: 'OpenRouter', description: 'Single key, hundreds of models.' },
  { id: 'groq', label: 'Groq', description: 'Sub-second open-weights inference.' },
  { id: 'mock', label: 'Mock', description: 'Built-in placeholder. No network calls.' },
];

export function Providers() {
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const clearApiKey = useAuthStore((s) => s.clearApiKey);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Providers</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Bring your own keys. Stored locally and never leave this device until you make a request.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        {BYOK_PROVIDERS.map((p) => (
          <ProviderKeyRow
            key={p.id}
            row={p}
            value={apiKeys[p.id] ?? ''}
            onSave={(v) => setApiKey(p.id, v)}
            onClear={() => clearApiKey(p.id)}
          />
        ))}
      </section>

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
            const hasKey = opt.id === 'mock' || !!apiKeys[opt.id];
            return (
              <button
                type="button"
                key={opt.id}
                role="radio"
                aria-checked={selected}
                onClick={() => setDefaultProvider(opt.id)}
                className={cn(
                  'flex items-center gap-3 rounded-md border bg-panel px-3 py-2 text-left transition-colors',
                  'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
                    {!hasKey && opt.id !== 'mock' && (
                      <Badge variant="outline">No key</Badge>
                    )}
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
}

function ProviderKeyRow({ row, value, onSave, onClear }: ProviderKeyRowProps) {
  // Single source of truth: `draft`. Sync to `value` on external change.
  // Browser handles masking via type="password" - no manual char replacement.
  const [draft, setDraft] = useState(value);
  const [revealed, setRevealed] = useState(() => Boolean(value));
  const [testing, setTesting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
    if (value) setRevealed(true);
  }, [value]);

  const dirty = draft !== value;

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setRevealed(true);
    fireApiKeySaveBurstFromElement(inputRef.current);
    toast.success(`${row.name} key saved`, 'Stored locally on this device.');
  }

  function handleTest() {
    const key = draft.trim();
    // For Ollama the field is a base URL, not a secret — empty just
    // means "use the default localhost endpoint", so let it through.
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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end justify-between gap-2">
        <Label htmlFor={`key-${row.id}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span>{row.name}</span>
          <span className="text-metadata text-muted-foreground font-normal">{row.hint}</span>
          {row.freeKeyUrl && (
            <a
              href={row.freeKeyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-metadata text-accent-copper underline-offset-4 hover:underline font-normal"
            >
              {row.freeKeyLabel ?? 'Get a free key'} →
            </a>
          )}
        </Label>
        {value && <Badge variant="success">Saved</Badge>}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1" data-jarvis-rainbow="true">
          <Input
            ref={inputRef}
            id={`key-${row.id}`}
            type={revealed ? 'text' : 'password'}
            placeholder={row.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              }
            }}
            className="pr-9 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={revealed ? 'Hide key' : 'Show key'}
            tabIndex={-1}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSave}
          disabled={!dirty || !draft.trim()}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing}>
          <Sparkles className="h-3.5 w-3.5" />
          {testing ? 'Testing...' : 'Test'}
        </Button>
        {value && (
          <Button variant="ghost" size="icon-sm" onClick={handleClear} aria-label="Remove key">
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}
