import { useSyncExternalStore } from 'react';
import { Switch } from '@/components/ui/switch';
import { browserTokenOptimizationPreferences } from './browserPreferences';
import { TOKEN_OPTIMIZATION_MODES, type TokenOptimizationMode } from './contracts';
import {
  MAX_DEFAULT_OUTPUT_TOKENS,
  MIN_DEFAULT_OUTPUT_TOKENS,
} from './modePreferences';

const LABELS: Readonly<Record<TokenOptimizationMode, string>> = {
  off: 'Off',
  saver: 'Token Saver',
  normal: 'Normal',
  final_boss: 'Token Final Boss',
};

export function TokenOptimizationGlobalSettings() {
  const preferences = useSyncExternalStore(
    browserTokenOptimizationPreferences.subscribe,
    browserTokenOptimizationPreferences.getSnapshot,
    browserTokenOptimizationPreferences.getSnapshot,
  );
  return (
    <section className="rounded-lg border border-border bg-panel p-4" aria-labelledby="token-mode">
      <div>
        <h3 id="token-mode" className="text-ui-strong text-foreground">
          Token Optimize
        </h3>
        <p className="text-metadata text-muted-foreground">
          Select relevant context and set a right-sized output budget. Your chosen model never
          changes.
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
        {TOKEN_OPTIMIZATION_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={preferences.globalMode === mode}
            className="rounded-md border border-border px-3 py-2 text-secondary text-foreground data-[selected=true]:border-accent-cyan data-[selected=true]:bg-accent-cyan/10"
            data-selected={preferences.globalMode === mode}
            onClick={() => browserTokenOptimizationPreferences.setGlobalMode(mode)}
          >
            {LABELS[mode]}
          </button>
        ))}
      </div>
      <p className="mt-3 text-metadata text-muted-foreground">
        Final Boss uses broader relevant context and deeper supported reasoning, then stops when
        the requirement is proven.
      </p>
      <div className="mt-4 grid gap-3 border-t border-border pt-4">
        <label className="grid gap-1 text-secondary text-foreground" htmlFor="token-output-limit">
          Default maximum output tokens
          <input
            id="token-output-limit"
            type="number"
            min={MIN_DEFAULT_OUTPUT_TOKENS}
            max={MAX_DEFAULT_OUTPUT_TOKENS}
            step={256}
            value={preferences.defaultMaxOutputTokens}
            className="h-9 w-36 rounded-md border border-border bg-surface px-3 text-secondary"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (
                Number.isSafeInteger(value) &&
                value >= MIN_DEFAULT_OUTPUT_TOKENS &&
                value <= MAX_DEFAULT_OUTPUT_TOKENS
              ) {
                browserTokenOptimizationPreferences.setDefaultMaxOutputTokens(value);
              }
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-secondary text-foreground">
          <span>
            Structural code compression
            <span className="block text-metadata text-muted-foreground">
              Compress eligible secondary code when repository context is available.
            </span>
          </span>
          <Switch
            checked={preferences.allowStructuralCodeCompression}
            onCheckedChange={(checked) =>
              browserTokenOptimizationPreferences.setAllowStructuralCodeCompression(checked)
            }
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-secondary text-foreground">
          <span>
            Show optimization report automatically
            <span className="block text-metadata text-muted-foreground">
              Keep usage evidence available even when this display is off.
            </span>
          </span>
          <Switch
            checked={preferences.showOptimizationReportAutomatically}
            onCheckedChange={(checked) =>
              browserTokenOptimizationPreferences.setShowOptimizationReportAutomatically(checked)
            }
          />
        </label>
        <div className="rounded-md bg-muted/40 px-3 py-2 text-metadata text-muted-foreground">
          <strong className="text-foreground">Selected model is locked.</strong> Token Optimize
          never changes the provider or model. Counting receipts identify exact local,
          provider-verified, or conservative estimates truthfully.
        </div>
      </div>
    </section>
  );
}
