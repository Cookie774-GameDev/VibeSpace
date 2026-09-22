import type { ConnectionMode } from './adapters/types';

const DISCLOSURE_VERSION = 2;
const STORAGE_KEY = 'vibespace.ai-route-disclosures.v1';

const SUBSCRIPTION_BRIDGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'openai-codex': 'Codex / ChatGPT',
  'anthropic-claude-code': 'Claude Code',
  'google-gemini-cli': 'Gemini CLI',
  'github-copilot-cli': 'GitHub Copilot',
  'qwen-code': 'Qwen Code',
  'zai-coding-plan': 'Z.AI Coding Plan',
});

const MANAGED_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  alibaba: 'Alibaba',
  'alibaba-token-plan': 'Alibaba Token Plan',
  azure: 'Azure',
  google: 'Gemini CLI',
  moonshot: 'Moonshot',
  openai: 'Codex / ChatGPT',
  qwen: 'Qwen Code',
  'qwen-coding-plan': 'Qwen Code',
});

function displayProviderOwner(owner: string): string {
  return (
    MANAGED_PROVIDER_LABELS[owner] ??
    owner
      .split(/[-_.]+/u)
      .filter(Boolean)
      .map((segment) => `${segment.slice(0, 1).toLocaleUpperCase('en-US')}${segment.slice(1)}`)
      .join(' ')
  );
}

function subscriptionRoute(input: RouteDisclosureInput): { bridge: string; apiProvider: string } {
  if (input.connectionId !== 'opencode-cli') {
    return {
      bridge: SUBSCRIPTION_BRIDGE_LABELS[input.connectionId] ?? input.providerId,
      apiProvider: input.providerId,
    };
  }
  const owner = input.modelLabel.trim().split('/').filter(Boolean)[0]?.toLocaleLowerCase('en-US');
  const apiProvider = displayProviderOwner(owner || input.providerId);
  return { bridge: apiProvider, apiProvider: owner === 'openai' ? 'OpenAI' : apiProvider };
}

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
    if (input.connectionId === 'opencode-cli') {
      return `Using ${input.modelLabel} through your OpenCode managed provider connection. Billing follows the authentication selected in OpenCode.`;
    }
    const { bridge, apiProvider } = subscriptionRoute(input);
    return `Using ${input.modelLabel} through your ${bridge} subscription. This route uses that authenticated subscription session, not your ${apiProvider} API key.`;
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
