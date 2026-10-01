import type {
  ContextInclusionReason,
  ReconciledTokenUsage,
  TokenOptimizationReceipt,
} from './optimizationReport';
import './tokenOptimizer.css';

const KIND_LABELS: Record<string, string> = {
  system_instruction: 'System instruction',
  latest_user_message: 'Latest user message',
  explicit_attachment: 'Explicit attachment',
  pinned_context_node: 'Pinned context',
  tool_schema: 'Tool schema',
  approval_requirement: 'Approval requirement',
  quoted_preserved_text: 'Preserved quote',
  exact_patch: 'Exact patch',
  structured_tool_data: 'Structured tool data',
  secret_detection_warning: 'Secret warning',
  repository_file: 'Repository file',
  repository_symbol: 'Repository symbol',
  memory: 'Memory',
  context_map_node: 'Context Map node',
  conversation_history: 'Conversation history',
  documentation: 'Documentation',
};

const INCLUSION_LABELS: Record<ContextInclusionReason, string> = {
  protected: 'Protected content',
  relevant: 'Selected by relevance',
};

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function TokenOptimizationReceiptView({
  receipt,
  usage,
}: {
  receipt: TokenOptimizationReceipt;
  usage?: ReconciledTokenUsage;
}) {
  const retainedPercent =
    receipt.estimatedInputTokensBefore === 0
      ? 0
      : Math.round((receipt.estimatedInputTokensAfter / receipt.estimatedInputTokensBefore) * 100);
  const includedByKind = (kind: string) =>
    receipt.inclusions.filter((item) => item.kind === kind).length;

  return (
    <section
      className="token-opt-panel token-opt-receipt"
      aria-labelledby="token-opt-receipt-title"
    >
      <header className="token-opt-heading">
        <div>
          <p className="token-opt-eyebrow">Optimization receipt</p>
          <h2 id="token-opt-receipt-title">
            {formatCount(receipt.estimatedTokensSaved)} tokens saved
          </h2>
        </div>
        <span className="token-opt-model-lock">
          {receipt.modelChanged ? 'Model changed' : 'Model unchanged'}
        </span>
      </header>

      <dl className="token-opt-metrics">
        <div>
          <dt>Before</dt>
          <dd>{formatCount(receipt.estimatedInputTokensBefore)}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>{formatCount(receipt.estimatedInputTokensAfter)}</dd>
        </div>
        <div>
          <dt>Output limit</dt>
          <dd>{formatCount(receipt.outputTokenLimit)}</dd>
        </div>
        <div>
          <dt>Count source</dt>
          <dd>{receipt.tokenizerSource.replaceAll('_', ' ')}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{receipt.mode.replaceAll('_', ' ')}</dd>
        </div>
        <div>
          <dt>Provider · model</dt>
          <dd>
            {receipt.providerId} · {receipt.modelId}
          </dd>
        </div>
        <div>
          <dt>Context considered</dt>
          <dd>{formatCount(receipt.selectedCount + receipt.excludedCount)}</dd>
        </div>
        <div>
          <dt>Files · symbols · memories</dt>
          <dd>
            {includedByKind('repository_file')} · {includedByKind('repository_symbol')} ·{' '}
            {includedByKind('memory')}
          </dd>
        </div>
        {usage ? (
          <>
            <div>
              <dt>Provider input</dt>
              <dd>{formatCount(usage.actualInputTokens)}</dd>
            </div>
            <div>
              <dt>Provider output</dt>
              <dd>{formatCount(usage.actualOutputTokens)}</dd>
            </div>
            {usage.actualReasoningTokens === undefined ? null : (
              <div>
                <dt>Reasoning tokens</dt>
                <dd>{formatCount(usage.actualReasoningTokens)}</dd>
              </div>
            )}
            {usage.actualCachedInputTokens === undefined ? null : (
              <div>
                <dt>Cached input</dt>
                <dd>{formatCount(usage.actualCachedInputTokens)}</dd>
              </div>
            )}
          </>
        ) : null}
      </dl>

      <div className="token-opt-budget-rail">
        <div className="token-opt-budget-label">
          <span>Context retained</span>
          <span>{retainedPercent}%</span>
        </div>
        <div
          className="token-opt-budget-track"
          role="progressbar"
          aria-label="Context retained"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, retainedPercent))}
        >
          <span style={{ width: `${Math.max(0, Math.min(100, retainedPercent))}%` }} />
        </div>
      </div>

      {!receipt.fitsContext ? (
        <p className="token-opt-overflow" role="alert">
          Protected context exceeds this model by {formatCount(receipt.overflowTokens)} tokens.
          Nothing was removed.
        </p>
      ) : null}

      <div className="token-opt-reason-columns">
        <section aria-labelledby="token-opt-included-title">
          <h3 id="token-opt-included-title">Why included</h3>
          {receipt.inclusions.length === 0 ? (
            <p className="token-opt-empty">No context segments were needed.</p>
          ) : (
            <ul className="token-opt-reason-list">
              {receipt.inclusions.map((item) => (
                <li key={item.segmentRef}>
                  <span>
                    <strong>{KIND_LABELS[item.kind] ?? item.kind}</strong>
                    <small>{INCLUSION_LABELS[item.reason]}</small>
                  </span>
                  <b>{formatCount(item.tokens)}</b>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="token-opt-excluded-title">
          <h3 id="token-opt-excluded-title">What changed</h3>
          {receipt.exclusions.length === 0 ? (
            <p className="token-opt-empty">No context was excluded.</p>
          ) : (
            <ul className="token-opt-reason-list">
              {receipt.exclusions.map((item) => (
                <li key={item.segmentRef}>
                  <span>
                    <strong>{KIND_LABELS[item.kind] ?? item.kind}</strong>
                    <small>{item.reason.replaceAll('_', ' ')}</small>
                  </span>
                  <b>−{formatCount(item.tokens)}</b>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
