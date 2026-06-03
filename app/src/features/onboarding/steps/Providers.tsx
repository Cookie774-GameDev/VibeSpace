import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Plus, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { ProviderId } from '@/types/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Onboarding — Providers step.
 *
 * V2 surfaces twelve providers, but during the 60-second onboarding we
 * only want to ask the user about the three majors (Anthropic / OpenAI /
 * Google). Everything else lives behind a "More providers" disclosure so
 * the user can opt-in without being overwhelmed. The deeper config —
 * default provider picker, tagging, test buttons — stays in
 * Settings → Providers.
 *
 * Persistence path matches V1: each row writes through
 * `useAuthStore.setApiKey`. We never touch the storage layer here.
 */

interface MajorProvider {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
}

interface CompatProvider {
  id: ProviderId;
  name: string;
  description: string;
  placeholder: string;
}

const MAJOR_PROVIDERS: MajorProvider[] = [
  { id: 'anthropic', name: 'Anthropic', hint: 'Claude family', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI', hint: 'GPT family', placeholder: 'sk-...' },
  { id: 'google', name: 'Google', hint: 'Gemini family', placeholder: 'AIza...' },
];

// OpenAI-compatible group. These all route through the openai-compatible
// adapter for V2 so persisting a key here is enough to use them in chat.
const COMPAT_PROVIDERS: CompatProvider[] = [
  { id: 'xai', name: 'xAI', description: 'Grok family', placeholder: 'xai-...' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Multi-model gateway', placeholder: 'sk-or-...' },
  { id: 'groq', name: 'Groq', description: 'Fast Llama / Mixtral', placeholder: 'gsk_...' },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek V3 / Coder', placeholder: 'sk-...' },
  { id: 'mistral', name: 'Mistral', description: 'Mistral Large / Nemo', placeholder: 'mistral-...' },
  { id: 'together', name: 'Together AI', description: 'Llama / Qwen open weights', placeholder: 'tgp_...' },
  { id: 'ollama', name: 'Ollama (local)', description: 'Local model server', placeholder: 'http://localhost:11434' },
];

interface ProvidersStepProps {
  onSkip: () => void;
}

export function Providers({ onSkip }: ProvidersStepProps) {
  // Default-collapsed: keeps the step scannable for users who only want a
  // major key. Auto-expand if the user has already stored a compat key
  // (e.g. they're re-running onboarding from settings).
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const hasCompatKey = COMPAT_PROVIDERS.some((p) => !!apiKeys[p.id]);
  const [moreOpen, setMoreOpen] = useState(hasCompatKey);

  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 py-10 gap-6 overflow-y-auto">
      <header className="text-center max-w-xl">
        <h2 className="text-hero leading-tight">Connect your models</h2>
        <p className="text-body text-muted-foreground mt-3">
          Bring your own keys. Stored locally and used directly from your device. The free path is a
          Google Gemini key (no card) — or run fully offline with a local model. You'll be asked to
          connect one before you start.
        </p>
      </header>

      {/* Majors — full inline editor per provider */}
      <section className="flex flex-col gap-3 w-full max-w-xl" aria-label="Major providers">
        {MAJOR_PROVIDERS.map((p) => (
          <MajorProviderRow key={p.id} row={p} />
        ))}
      </section>

      {/* OpenAI-compatible group — collapsed by default */}
      <section className="w-full max-w-xl" aria-label="More providers">
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className={cn(
            'w-full flex items-center justify-between gap-2 rounded-md border border-border bg-panel/60',
            'px-3 py-2 text-left transition-colors hover:bg-elevated',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <span className="flex items-center gap-2 min-w-0">
            {moreOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-accent-copper shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-accent-copper shrink-0" />
            )}
            <span className="text-ui-strong text-foreground">More providers</span>
            <span className="text-metadata text-muted-foreground truncate">
              OpenAI-compatible &amp; local
            </span>
          </span>
          <Badge variant="outline" className="shrink-0">
            {COMPAT_PROVIDERS.length}
          </Badge>
        </button>

        <AnimatePresence initial={false}>
          {moreOpen && (
            <motion.div
              key="compat-grid"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2"
            >
              {COMPAT_PROVIDERS.map((p) => (
                <CompatProviderCard key={p.id} row={p} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <p className="text-metadata text-muted-foreground text-center max-w-md">
        You can add or change keys anytime in Settings &rarr; Providers.
      </p>

      {/* Save & continue commits any in-flight drafts (each input commits
          on blur, which the button click triggers naturally) and advances. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="text-secondary text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
        >
          Skip for now
        </button>
        <Button variant="accent" size="sm" onClick={onSkip}>
          Save &amp; continue
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// Major provider row — always-visible input
// ============================================================

function MajorProviderRow({ row }: { row: MajorProvider }) {
  const stored = useAuthStore((s) => s.apiKeys[row.id] ?? '');
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const clearApiKey = useAuthStore((s) => s.clearApiKey);

  const [draft, setDraft] = useState(stored);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  function commit(value: string) {
    const trimmed = value.trim();
    if (trimmed) {
      setApiKey(row.id, trimmed);
    } else if (stored) {
      clearApiKey(row.id);
    }
  }

  return (
    <div
      className={cn(
        'rounded-md border p-3 flex flex-col gap-2 transition-colors',
        stored ? 'border-accent-copper/40 bg-elevated' : 'border-border bg-panel',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`onb-key-${row.id}`} className="flex items-center gap-2">
          <span className="text-ui-strong text-foreground">{row.name}</span>
          <span className="text-metadata text-muted-foreground font-normal">{row.hint}</span>
        </Label>
        {stored && (
          <Badge variant="success">
            <Check className="h-3 w-3" />
            Saved
          </Badge>
        )}
      </div>
      <div className="relative" data-jarvis-rainbow="true">
        <Input
          id={`onb-key-${row.id}`}
          type={revealed ? 'text' : 'password'}
          placeholder={row.placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(draft);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          className={cn('pr-9 font-mono')}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRevealed((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={revealed ? 'Hide key' : 'Show key'}
          tabIndex={-1}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Compat provider card — input on demand
// ============================================================

function CompatProviderCard({ row }: { row: CompatProvider }) {
  const stored = useAuthStore((s) => s.apiKeys[row.id] ?? '');
  const setApiKey = useAuthStore((s) => s.setApiKey);
  const clearApiKey = useAuthStore((s) => s.clearApiKey);

  // Auto-open if a key is already saved so the user sees what's there.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed) {
      setApiKey(row.id, trimmed);
    } else if (stored) {
      clearApiKey(row.id);
    }
  }

  function commitAndClose() {
    commit();
    setEditing(false);
    setRevealed(false);
  }

  function cancel() {
    setDraft(stored);
    setEditing(false);
    setRevealed(false);
  }

  return (
    <div
      className={cn(
        'rounded-md border p-3 flex flex-col gap-2 transition-colors',
        stored ? 'border-accent-copper/40 bg-elevated' : 'border-border bg-panel',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-ui-strong text-foreground">{row.name}</span>
            {stored && (
              <Badge variant="success">
                <Check className="h-3 w-3" />
                Saved
              </Badge>
            )}
          </div>
          <p className="text-metadata text-muted-foreground mt-0.5 truncate">{row.description}</p>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant={stored ? 'ghost' : 'secondary'}
            onClick={() => setEditing(true)}
            className="shrink-0"
          >
            {stored ? (
              'Edit'
            ) : (
              <>
                <Plus className="h-3 w-3" />
                Add key
              </>
            )}
          </Button>
        )}
      </div>

      {editing && (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1" data-jarvis-rainbow="true">
            <Input
              type={revealed ? 'text' : 'password'}
              placeholder={row.placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitAndClose();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
              className="pr-9 font-mono"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setRevealed((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={revealed ? 'Hide key' : 'Show key'}
              tabIndex={-1}
            >
              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={cancel}
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
