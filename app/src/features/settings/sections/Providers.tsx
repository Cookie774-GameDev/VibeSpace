import { useEffect, useState } from 'react';
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

interface ProviderRow {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
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
    hint: 'Gemini Pro / Flash',
    placeholder: 'AIza...',
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
    hint: 'Fast Llama / Mixtral inference',
    placeholder: 'gsk_...',
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
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed);
    toast.success(`${row.name} key saved`, 'Stored locally on this device.');
  }

  function handleTest() {
    const key = draft.trim();
    if (!key) {
      toast.warning('No key to test', `Enter a ${row.name} key first.`);
      return;
    }
    setTesting(true);
    setTimeout(() => {
      setTesting(false);
      // Mock - real validation will hit the provider once that's wired.
      toast.info(`${row.name} key looks plausible`, 'Live validation lands soon.');
    }, 350);
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
        <Label htmlFor={`key-${row.id}`}>
          {row.name}
          <span className="text-metadata text-muted-foreground font-normal ml-2">{row.hint}</span>
        </Label>
        {value && <Badge variant="success">Saved</Badge>}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
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
