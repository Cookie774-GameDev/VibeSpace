import type { TokenOptimizationMode } from './contracts';
import './tokenOptimizer.css';

const MODE_COPY: Readonly<
  Record<TokenOptimizationMode, Readonly<{ label: string; description: string }>>
> = Object.freeze({
  off: Object.freeze({
    label: 'Off',
    description: 'Keep context and output limits unchanged.',
  }),
  saver: Object.freeze({
    label: 'Saver',
    description: 'Keep only high-value context and cap output tightly.',
  }),
  normal: Object.freeze({
    label: 'Normal',
    description: 'Balance useful context with a practical output budget.',
  }),
  final_boss: Object.freeze({
    label: 'Final Boss',
    description: 'Keep broader context and use the highest appropriate reasoning.',
  }),
});

const MODES = Object.keys(MODE_COPY) as TokenOptimizationMode[];

export interface TokenOptimizationModeControlProps {
  globalMode: TokenOptimizationMode;
  chatOverride: TokenOptimizationMode | null;
  onGlobalModeChange(mode: TokenOptimizationMode): void;
  onChatOverrideChange(mode: TokenOptimizationMode | null): void;
  disabled?: boolean;
}

function ModeOptions({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: TokenOptimizationMode | null;
  onChange(mode: TokenOptimizationMode): void;
  disabled: boolean;
}) {
  return (
    <div className="token-opt-mode-grid">
      {MODES.map((mode) => {
        const copy = MODE_COPY[mode];
        return (
          <label className="token-opt-mode-card" data-selected={value === mode} key={mode}>
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value === mode}
              disabled={disabled}
              onChange={() => onChange(mode)}
            />
            <span className="token-opt-mode-mark" aria-hidden="true" />
            <span className="token-opt-mode-copy">
              <span className="token-opt-mode-label">{copy.label}</span>
              <span className="token-opt-mode-description">{copy.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function TokenOptimizationModeControl({
  globalMode,
  chatOverride,
  onGlobalModeChange,
  onChatOverrideChange,
  disabled = false,
}: TokenOptimizationModeControlProps) {
  return (
    <section className="token-opt-panel" aria-labelledby="token-opt-control-title">
      <header className="token-opt-heading">
        <div>
          <p className="token-opt-eyebrow">Token Optimize</p>
          <h2 id="token-opt-control-title">Spend context deliberately</h2>
        </div>
        <span className="token-opt-model-lock">Model stays fixed</span>
      </header>

      <fieldset className="token-opt-fieldset" disabled={disabled}>
        <legend>Global default</legend>
        <p>Used whenever a chat does not have its own override.</p>
        <ModeOptions
          name="token-opt-global-mode"
          value={globalMode}
          onChange={onGlobalModeChange}
          disabled={disabled}
        />
      </fieldset>

      <fieldset className="token-opt-fieldset token-opt-chat-fieldset" disabled={disabled}>
        <legend>This chat</legend>
        <label className="token-opt-inherit-row" data-selected={chatOverride === null}>
          <input
            type="radio"
            name="token-opt-chat-mode"
            checked={chatOverride === null}
            disabled={disabled}
            onChange={() => onChatOverrideChange(null)}
          />
          <span>
            <strong>Inherit global</strong>
            <small>Currently {MODE_COPY[globalMode].label}</small>
          </span>
        </label>
        <ModeOptions
          name="token-opt-chat-mode"
          value={chatOverride}
          onChange={onChatOverrideChange}
          disabled={disabled}
        />
      </fieldset>
    </section>
  );
}
