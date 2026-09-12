import { describe, expect, it } from 'vitest';
import {
  connectorModeLabel,
  connectorStatusLabel,
  resolveConnectorUiStatus,
} from './connectorStatus';
import type { ProviderConnection } from '@/lib/ai/adapters/types';

const cli: Readonly<ProviderConnection> = Object.freeze({
  id: 'openai-codex',
  adapterId: 'codex-cli',
  providerId: 'openai',
  displayName: 'Codex CLI',
  mode: 'external-cli',
  authSource: 'codex-cli-session',
  capabilities: Object.freeze({
    text: true,
    images: false,
    files: false,
    tools: false,
    modelSelection: true,
    structuredOutput: true,
    streaming: true,
    cancellation: true,
    resumeSession: false,
    systemPrompt: false,
    workingDirectory: true,
    usage: true,
    subscriptionQuota: false,
    localOnly: false,
  }),
  promptTransport: 'prefixed-preamble',
  enabled: true,
});

const api: Readonly<ProviderConnection> = Object.freeze({
  ...cli,
  id: 'openai-api',
  mode: 'native-api',
  authSource: 'api-key',
  promptTransport: 'native-system',
});

describe('connectorStatus', () => {
  it('maps CLI signed-in subscription distinctly from API-key configured', () => {
    expect(
      resolveConnectorUiStatus({
        connection: cli,
        record: { installation: 'installed', auth: 'authenticated', lastCheckedAt: 1 },
      }),
    ).toBe('signed-in');
    expect(connectorStatusLabel('signed-in')).toMatch(/subscription/i);

    expect(
      resolveConnectorUiStatus({
        connection: api,
        credentialsReady: true,
      }),
    ).toBe('configured');
    expect(connectorStatusLabel('configured')).toMatch(/API key/i);
  });

  it('surfaces checking, disabled, unavailable, and error states', () => {
    expect(resolveConnectorUiStatus({ connection: cli, checking: true })).toBe('checking');
    expect(
      resolveConnectorUiStatus({
        connection: cli,
        record: { installation: 'installed', auth: 'authenticated', disabled: true },
      }),
    ).toBe('disabled');
    expect(
      resolveConnectorUiStatus({
        connection: cli,
        record: { installation: 'not-installed', auth: 'unknown', lastCheckedAt: 1 },
      }),
    ).toBe('unavailable');
    expect(resolveConnectorUiStatus({ connection: cli, error: 'probe failed' })).toBe('error');
  });

  it('keeps mode labels distinct for UI hierarchy', () => {
    expect(connectorModeLabel('external-cli')).toMatch(/subscription/i);
    expect(connectorModeLabel('native-api')).toMatch(/API key/i);
    expect(connectorModeLabel('local')).toMatch(/Local/i);
  });
});
