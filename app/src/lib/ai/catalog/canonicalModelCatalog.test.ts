import { describe, expect, it } from 'vitest';
import {
  ModelCatalogController,
  buildCanonicalModelRows,
  canonicalProviderModelId,
  dedupeConnectionModels,
  dedupeModelMetadata,
  suppressHealthyLegacyRoutes,
  type ConnectionModelRecord,
} from './canonicalModelCatalog';

const record = (overrides: Partial<ConnectionModelRecord> = {}): ConnectionModelRecord => ({
  connectionId: 'opencode-openai-pro',
  providerId: 'openai',
  modelId: 'openai/gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  available: true,
  source: 'opencode-live',
  lastVerifiedAt: 100,
  variants: [{ id: 'medium' }],
  capabilities: { tools: true },
  serviceTiers: ['fast'],
  ...overrides,
});

describe('canonical model catalog', () => {
  it('deduplicates identical metadata inside one connection and prefers live truth', () => {
    const rows = dedupeModelMetadata([
      { id: ' GPT-5.6-SOL ', label: 'Static', source: 'connection-static' as const },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', source: 'opencode-live' as const, variants: ['max'] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'GPT-5.6 Sol', source: 'opencode-live' });
    expect(rows[0].variants).toEqual(['max']);
  });

  it('treats provider-qualified and unqualified IDs as the same model only for the exact provider', () => {
    expect(canonicalProviderModelId('openai', 'openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(canonicalProviderModelId('openai', 'anthropic/gpt-5.6-sol')).toBe('anthropic/gpt-5.6-sol');
    const rows = dedupeConnectionModels([
      record(),
      record({ modelId: 'gpt-5.6-sol', source: 'provider-live' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].serviceTiers).toEqual(['fast']);
  });

  it('renders one visible model while retaining exact API and subscription routes', () => {
    const rows = buildCanonicalModelRows([
      record(),
      record({ connectionId: 'openai-api-personal', modelId: 'gpt-5.6-sol', source: 'provider-live' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: 'gpt-5.6-sol', preferredConnectionId: 'opencode-openai-pro' });
    expect(rows[0].routes.map((route) => route.connectionId)).toEqual([
      'opencode-openai-pro',
      'openai-api-personal',
    ]);
  });

  it('suppresses the legacy Codex CLI route only when modern OpenCode is healthy', () => {
    const legacy = record({ connectionId: 'openai-codex', legacyTransport: true });
    const modern = record({ connectionId: 'opencode-openai-pro' });
    const policy = { modernConnectionIds: ['opencode-openai-pro'], legacyConnectionIds: ['openai-codex'] };
    expect(suppressHealthyLegacyRoutes([legacy, modern], policy).map((item) => item.connectionId)).toEqual([
      'opencode-openai-pro',
    ]);
    expect(suppressHealthyLegacyRoutes([legacy, { ...modern, available: false }], policy)).toHaveLength(2);
  });

  it('refreshes by explicit generation rather than render count', () => {
    const controller = new ModelCatalogController();
    const first = controller.replace([record()], 'initial', 100);
    const second = controller.replace([record({ modelId: 'gpt-5.3-codex-spark' })], 'auth-change', 200);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(controller.isExpired(500, 600)).toBe(false);
    expect(controller.isExpired(500, 700)).toBe(true);
  });
});
