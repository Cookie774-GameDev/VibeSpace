import { publicToolDetails } from '@/lib/ai/publicToolDetails';
import type { PublicToolDetails } from '@/lib/ai/adapters/types';
import { applySecretPolicy } from '@/lib/security/secretDetector';
import type { Part } from '@/types';

type ToolCallPart = Extract<Part, { kind: 'tool_call' }>;

const PATH_ARGUMENT_KEYS = new Set(['path', 'filePath', 'file_path', 'filepath']);

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/u.test(clean)) return undefined;
  return clean;
}

/** Keep the same relative-or-leaf path policy as the OpenCode public projection. */
function safeHistoricalFileLabel(value: string): string | undefined {
  if (!value.trim() || value.length > 4_096) return undefined;
  const normalized = value.replace(/\\/g, '/');
  const safeRelative = !/^(?:[a-z]:|\/)/i.test(normalized) && !normalized.split('/').includes('..');
  const label = safeRelative
    ? normalized.replace(/^\.\//, '')
    : normalized.split('/').filter(Boolean).at(-1);
  if (!label) return undefined;
  const redacted = applySecretPolicy(label, 'redact').text;
  return boundedIdentifier(redacted, 4_096);
}

/**
 * Recover display arguments from the bounded public details retained by old
 * OpenCode messages. Explicit persisted args always win unchanged.
 */
export function displayToolCallArgs(call: ToolCallPart): Readonly<Record<string, unknown>> {
  const explicitArgs = recordOf(call.args);
  if (explicitArgs && Object.keys(explicitArgs).length > 0) return explicitArgs;

  const persistedDetails: Readonly<PublicToolDetails> | undefined = call.details;
  let persistedArguments: unknown = persistedDetails?.arguments;
  if (typeof persistedArguments === 'string' && persistedArguments.length <= 16_384) {
    try {
      persistedArguments = JSON.parse(persistedArguments) as unknown;
    } catch {
      // Malformed historical text cannot be recovered as structured arguments.
    }
  }
  const details = publicToolDetails({ arguments: persistedArguments });
  const source = recordOf(details.arguments);
  if (!source) return explicitArgs ?? {};

  const args: Record<string, unknown> = {};
  let pathValue: string | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (PATH_ARGUMENT_KEYS.has(key)) {
      if (pathValue === undefined && typeof value === 'string') pathValue = value;
      continue;
    }
    args[key] = value;
  }
  const fileLabel = pathValue === undefined ? undefined : safeHistoricalFileLabel(pathValue);
  if (fileLabel) args.path = fileLabel;
  return args;
}
