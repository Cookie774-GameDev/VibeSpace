import type { ConnectionMode } from './adapters/types';

const DISCLOSURE_VERSION = 1;
const STORAGE_KEY = 'vibespace.ai-route-disclosures.v1';

interface RouteDisclosureInput {
  accountId: string;
  connectionId: string;
  connectionMode: ConnectionMode;
  providerId: string;
  modelLabel: string;
}

function acknowledgementId(input: RouteDisclosureInput): string {
  return `${input.accountId}\u0000${input.connectionId}\u0000${DISCLOSURE_VERSION}`;
}

function readAcknowledgements(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string' && value.length < 256)
        : [],
    );
  } catch {
    return new Set();
  }
}

export function buildConnectionRouteDisclosure(input: RouteDisclosureInput): string {
  if (input.connectionMode === 'external-cli') {
    return `Using ${input.modelLabel} through your ${input.connectionId === 'openai-codex' ? 'Codex / ChatGPT' : input.providerId} subscription bridge. This route uses that authenticated subscription session, not your ${input.providerId} API key.`;
  }
  if (input.connectionMode === 'native-api') {
    return `Using ${input.modelLabel} through your ${input.providerId} API connection. Requests on this route may incur provider API charges.`;
  }
  return `Using ${input.modelLabel} through the local ${input.providerId} connection. This route runs locally and does not use a cloud API key.`;
}

export function needsConnectionRouteDisclosure(input: RouteDisclosureInput): boolean {
  return !readAcknowledgements().has(acknowledgementId(input));
}

export function acknowledgeConnectionRouteDisclosure(input: RouteDisclosureInput): void {
  if (typeof window === 'undefined') return;
  const acknowledgements = readAcknowledgements();
  acknowledgements.add(acknowledgementId(input));
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...acknowledgements]));
}

export function resetConnectionRouteDisclosuresForTests(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
}
