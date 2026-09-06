import type { Message } from '@/types';

const MODES = { normal: 'Normal', 'token-saver': 'Token Saver', 'token-final-boss': 'Token Final Boss' };

/** Display only the receipt saved with this response, never current picker state. */
export function ResponseDetails({ usage }: { usage: Message['usage'] }) {
  if (!usage?.execution) return null;
  const { input_tokens: input, output_tokens: output } = usage;
  const known = usage.provenance !== 'unavailable' && typeof input === 'number' &&
    Number.isSafeInteger(input) && input >= 0 && typeof output === 'number' &&
    Number.isSafeInteger(output) && output >= 0;
  const total = Number.isSafeInteger(usage.total_tokens) && usage.total_tokens! >= 0 ? usage.total_tokens! : (input ?? 0) + (output ?? 0);
  const effort = usage.execution.effort;
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Response details</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
        <dt>Mode</dt><dd>{MODES[usage.execution.mode]}</dd>
        <dt>Provider</dt><dd>{usage.provider ?? 'Unavailable'}</dd>
        <dt>Model</dt><dd className="break-all">{usage.model ?? 'Unavailable'}</dd>
        <dt>Effort</dt><dd>{!effort || effort === 'auto' ? 'Provider default' : effort}</dd>
        <dt>Tokens</dt><dd>{known ? `${usage.provenance === 'estimated' ? 'Estimated ' : 'Reported '}${total.toLocaleString()}` : 'Unavailable'}</dd>
        {known && usage.total_tokens !== undefined ? <><dt>Input</dt><dd>{input!.toLocaleString()}</dd><dt>Output</dt><dd>{output!.toLocaleString()}</dd></> : null}
        {known && Number.isSafeInteger(usage.cache_read_tokens) && usage.cache_read_tokens! >= 0 ? <><dt>Cached input</dt><dd>{usage.cache_read_tokens!.toLocaleString()}</dd></> : null}
        {known && Number.isSafeInteger(usage.cache_write_tokens) && usage.cache_write_tokens! > 0 ? <><dt>Cache writes</dt><dd>{usage.cache_write_tokens!.toLocaleString()}</dd></> : null}
      </dl>
    </details>
  );
}
