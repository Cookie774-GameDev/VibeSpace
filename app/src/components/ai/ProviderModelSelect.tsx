import * as React from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ProviderId } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { rememberSettingsTab } from '@/features/settings/settingsTabMemory';
import {
  getProviderDisplayName,
  isProviderConnected,
} from '@/lib/ai/providerRegistry';
import {
  resolveModelOnProviderChange,
  sanitizeModelIdForInput,
  validateProviderModelSelection,
} from '@/lib/ai/providerModelCatalog';
import { useProviderModelOptions } from '@/lib/ai/useProviderModelOptions';

function goToProvidersSettings(): void {
  rememberSettingsTab('providers');
  useUIStore.getState().setSettingsOpen(true);
}

export interface ProviderModelSelectProps {
  providerId: ProviderId;
  modelId: string;
  onProviderChange: (providerId: ProviderId) => void;
  onModelChange: (modelId: string) => void;
  providers?: ProviderId[];
  providerLabel?: string;
  modelLabel?: string;
  className?: string;
  idPrefix?: string;
}

export function ProviderModelSelect({
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
  providers,
  providerLabel = 'Provider',
  modelLabel = 'Model',
  className,
  idPrefix = 'provider-model',
}: ProviderModelSelectProps) {
  const [advancedCustom, setAdvancedCustom] = React.useState(false);
  const { ctx, providerOptions, modelOptions, refreshing, loadError, refreshModels } =
    useProviderModelOptions({
      providerId,
      savedModelId: modelId,
      providers,
    });

  const connected = isProviderConnected(providerId, ctx);
  const validation = validateProviderModelSelection(providerId, modelId, ctx, {
    allowCustom: advancedCustom,
  });

  const knownModel = modelOptions.some(
    (option) => option.id.toLowerCase() === sanitizeModelIdForInput(modelId).toLowerCase() && !option.isCustom,
  );

  React.useEffect(() => {
    if (!knownModel && modelId.trim()) setAdvancedCustom(true);
  }, [knownModel, modelId]);

  const handleProviderChange = (nextProvider: ProviderId) => {
    const nextModel = resolveModelOnProviderChange(nextProvider, modelId, ctx);
    onProviderChange(nextProvider);
    onModelChange(nextModel);
    setAdvancedCustom(false);
  };

  const providerSelectId = `${idPrefix}-provider`;
  const modelSelectId = `${idPrefix}-model`;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1" htmlFor={providerSelectId}>
          <span className="text-metadata text-muted-foreground">{providerLabel}</span>
          <select
            id={providerSelectId}
            value={providerId}
            onChange={(event) => handleProviderChange(event.target.value as ProviderId)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-body text-foreground"
          >
            {providerOptions.map((option) => (
              <option key={option.providerId} value={option.providerId} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-metadata text-muted-foreground" htmlFor={modelSelectId}>
              {modelLabel}
            </label>
            {connected && (
              <button
                type="button"
                onClick={() => void refreshModels()}
                disabled={refreshing}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                aria-label="Refresh model list"
              >
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
                Refresh
              </button>
            )}
          </div>

          {!connected ? (
            <div className="rounded-md border border-dashed border-accent-copper/35 bg-accent-copper/5 px-2.5 py-2 text-secondary text-muted-foreground">
              <p>
                Connect your {getProviderDisplayName(providerId)} API key to load{' '}
                {getProviderDisplayName(providerId)} models.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2"
                onClick={goToProvidersSettings}
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Go to Providers
              </Button>
            </div>
          ) : advancedCustom ? (
            <Input
              id={modelSelectId}
              value={modelId}
              onChange={(event) => onModelChange(sanitizeModelIdForInput(event.target.value))}
              placeholder="custom-model-id"
              spellCheck={false}
              autoComplete="off"
            />
          ) : modelOptions.length > 0 ? (
            <select
              id={modelSelectId}
              value={modelOptions.some((option) => option.id === modelId) ? modelId : ''}
              onChange={(event) => onModelChange(event.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-body text-foreground"
            >
              {!modelOptions.some((option) => option.id === modelId) && modelId ? (
                <option value="" disabled>
                  Select a model
                </option>
              ) : null}
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                  {option.availability === 'preview' ? ' (preview)' : ''}
                  {option.isCustom ? ' (custom)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-md border border-dashed border-border px-2.5 py-2 text-secondary text-muted-foreground">
              {loadError
                ? `Could not load ${getProviderDisplayName(providerId)} models. Check your API key or try refreshing.`
                : `Select a provider first.`}
            </div>
          )}

          {connected && (
            <label className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={advancedCustom}
                onChange={(event) => {
                  setAdvancedCustom(event.target.checked);
                  if (!event.target.checked && modelOptions[0]) {
                    const keep = modelOptions.find((option) => option.id === modelId && !option.isCustom);
                    onModelChange(keep?.id ?? modelOptions[0].id);
                  }
                }}
              />
              Advanced: custom model ID
            </label>
          )}
        </div>
      </div>

      {!validation.ok && validation.error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {validation.error}
        </p>
      ) : null}
      {validation.warning ? (
        <p className="text-[12px] text-amber-600 dark:text-amber-400" role="status">
          {validation.warning}
        </p>
      ) : null}
      {loadError && connected ? (
        <p className="text-[12px] text-muted-foreground">
          Could not reach {getProviderDisplayName(providerId)} right now. Showing cached models.
        </p>
      ) : null}
    </div>
  );
}

export default ProviderModelSelect;
