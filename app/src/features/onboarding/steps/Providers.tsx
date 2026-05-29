import { useEffect, useState } from 'react';
import { Eye, EyeOff, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { ProviderId } from '@/types/common';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ProviderRow {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
}

const PROVIDERS: ProviderRow[] = [
  { id: 'anthropic', name: 'Anthropic', hint: 'Claude family', placeholder: 'sk-ant-...' },
  { id: 'openai', name: 'OpenAI', hint: 'GPT family', placeholder: 'sk-...' },
  { id: 'google', name: 'Google', hint: 'Gemini family', placeholder: 'AIza...' },
];

interface ProvidersStepProps {
  onSkip: () => void;
}

export function Providers({ onSkip }: ProvidersStepProps) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 py-10 gap-8 overflow-y-auto">
      <header className="text-center max-w-xl">
        <h2 className="text-hero leading-tight">Connect your models</h2>
        <p className="text-body text-muted-foreground mt-3">
          Bring your own keys. Stored locally and used directly from your device. You can skip this
          and use the built-in mock provider for now.
        </p>
      </header>

      <div className="flex flex-col gap-3 w-full max-w-xl">
        {PROVIDERS.map((p) => (
          <ProviderRowComp key={p.id} row={p} />
        ))}
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="text-secondary text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
      >
        Skip - I'll use the mock provider for now
      </button>
    </div>
  );
}

function ProviderRowComp({ row }: { row: ProviderRow }) {
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
    <div className="rounded-md border border-border bg-panel p-3 flex flex-col gap-2">
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
      <div className="relative">
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
