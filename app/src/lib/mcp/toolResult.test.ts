import { describe, expect, it } from 'vitest';

import {
  normalizeExternalMcpToolResult,
  redactMcpArgumentsForAudit,
  redactMcpArgumentsForAuditWithStats,
} from './toolResult';

describe('external MCP tool-result normalization', () => {
  it('returns a bounded safe contract and never forwards inline media or unsafe references', () => {
    const result = normalizeExternalMcpToolResult({
      content: [
        {
          type: 'text',
          text: 'Report ready. Authorization: Bearer synthetic-super-secret-token-value',
        },
        {
          type: 'resource_link',
          uri: 'https://example.com/report/42',
          name: 'report-42',
          title: 'Quarterly report',
          mimeType: 'text/html',
        },
        {
          type: 'resource_link',
          uri: 'file:///C:/Users/viper/.ssh/id_ed25519',
          name: 'private-key',
        },
        {
          type: 'image',
          data: 'A'.repeat(400_000),
          mimeType: 'image/png',
        },
      ],
      structuredContent: {
        reportId: 42,
        apiKey: 'synthetic-api-key-value',
        nested: {
          token: 'sk-proj-synthetic-token-material-1234567890',
          accessToken: 'synthetic-camel-token',
          state: 'ready',
        },
        suggestedNextActions: ['Open https://example.com/report/42', 'Use Bearer secret-next'],
      },
    });

    expect(result).toEqual({
      ok: true,
      contentTrust: 'external_untrusted',
      safeSummary:
        'External MCP tool completed with 1 text result, 1 source reference and structured data; 1 inline media item and 1 unsafe reference were omitted.',
      textExcerpts: ['Report ready. Authorization: Bearer [REDACTED]'],
      sourceRefs: [
        {
          uri: 'https://example.com/report/42',
          name: 'report-42',
          title: 'Quarterly report',
          mimeType: 'text/html',
        },
      ],
      artifacts: [
        {
          kind: 'link',
          uri: 'https://example.com/report/42',
          title: 'Quarterly report',
          mimeType: 'text/html',
        },
      ],
      suggestedNextActions: ['Open https://example.com/report/42', 'Use Bearer [REDACTED]'],
      structuredData: {
        reportId: 42,
        apiKey: '[REDACTED]',
        nested: {
          token: '[REDACTED]',
          accessToken: '[REDACTED]',
          state: 'ready',
        },
      },
      omitted: {
        inlineMedia: 1,
        unsafeReferences: 1,
        truncatedValues: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-super-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-api-key-value');
    expect(JSON.stringify(result)).not.toContain('sk-proj-');
    expect(JSON.stringify(result)).not.toContain('AAAA');
    expect(JSON.stringify(result)).not.toContain('.ssh');
  });

  it('preserves tool execution errors as bounded untrusted evidence', () => {
    expect(
      normalizeExternalMcpToolResult({
        content: [{ type: 'text', text: 'Invalid date. password=hunter-synthetic' }],
        isError: true,
      }),
    ).toEqual({
      ok: false,
      contentTrust: 'external_untrusted',
      safeSummary: 'External MCP tool reported an execution error with 1 text result.',
      textExcerpts: ['Invalid date. password=[REDACTED]'],
      sourceRefs: [],
      artifacts: [],
      suggestedNextActions: [],
      omitted: {
        inlineMedia: 0,
        unsafeReferences: 0,
        truncatedValues: 0,
      },
    });
  });

  it('removes credential-shaped query parameters and fragments from retained links', () => {
    const result = normalizeExternalMcpToolResult({
      content: [
        {
          type: 'resource_link',
          uri: 'https://example.com/report?view=full&token=synthetic-secret#sk-proj-synthetic-fragment-1234567890',
          name: 'report',
        },
      ],
    });

    expect(result.sourceRefs).toEqual([
      {
        uri: 'https://example.com/report?view=full',
        name: 'report',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(JSON.stringify(result)).not.toContain('sk-proj-');
  });

  it('redacts URL userinfo and credential-shaped query values in text fields', () => {
    const result = normalizeExternalMcpToolResult({
      content: [{
        type: 'text',
        text: 'Visit https://user:synthetic-password@example.com/report?access_token=synthetic-token&view=full',
      }],
      structuredContent: {
        suggestedNextActions: [
          'Open https://user:synthetic-password@example.com/report?refresh_token=synthetic-refresh',
        ],
      },
    });

    expect(result.textExcerpts).toEqual([
      'Visit https://example.com/report?access_token=[REDACTED]&view=full',
    ]);
    expect(result.suggestedNextActions).toEqual([
      'Open https://example.com/report?refresh_token=[REDACTED]',
    ]);
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(JSON.stringify(result)).not.toContain('synthetic-refresh');
  });

  it('rejects retained links whose path contains credential-shaped material', () => {
    const result = normalizeExternalMcpToolResult({
      content: [
        {
          type: 'resource_link',
          uri: 'https://example.com/sk-proj-synthetic-path-token-1234567890/report',
          name: 'credential-path',
        },
      ],
    });

    expect(result.sourceRefs).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.omitted.unsafeReferences).toBe(1);
    expect(JSON.stringify(result)).not.toContain('sk-proj-');
  });

  it('accepts a legacy structured adapter result but bounds giant provider values', () => {
    const result = normalizeExternalMcpToolResult({
      rows: Array.from({ length: 100 }, (_, index) => ({
        index,
        body: `row-${index}-${'x'.repeat(3_000)}`,
      })),
      private_key: '-----BEGIN PRIVATE KEY----- synthetic material',
    });

    expect(result.safeSummary).toBe('External MCP tool completed with structured data.');
    expect(result.textExcerpts).toEqual([]);
    expect(result.structuredData).toBeDefined();
    expect(JSON.stringify(result).length).toBeLessThan(40_000);
    expect(result.omitted.truncatedValues).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY');
  });

  it.each([
    [
      'cyclic data',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return { content: [], structuredContent: value };
      },
    ],
    [
      'accessor data',
      () => ({
        content: [],
        structuredContent: Object.defineProperty({}, 'secret', {
          enumerable: true,
          get: () => 'should-not-run',
        }),
      }),
    ],
    [
      'too-deep data',
      () => {
        let value: Record<string, unknown> = { end: true };
        for (let index = 0; index < 10; index += 1) value = { child: value };
        return { content: [], structuredContent: value };
      },
    ],
  ])('rejects unsafe %s without evaluating or partially returning it', (_label, create) => {
    expect(() => normalizeExternalMcpToolResult(create())).toThrow(/invalid MCP tool result/i);
  });

  it('returns detached deeply frozen data', () => {
    const raw = {
      content: [{ type: 'text', text: 'ready' }],
      structuredContent: { nested: { value: 1 } },
    };
    const result = normalizeExternalMcpToolResult(raw);

    raw.content[0]!.text = 'mutated';
    raw.structuredContent.nested.value = 2;

    expect(result.textExcerpts).toEqual(['ready']);
    expect(result.structuredData).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.structuredData)).toBe(true);
    expect(Object.isFrozen((result.structuredData as { nested: object }).nested)).toBe(true);
  });
});

describe('MCP invocation argument audit redaction', () => {
  it('detaches, bounds, freezes, and redacts secret keys and token-shaped text', () => {
    const input = {
      query: 'recent invoices',
      password: 'synthetic-password',
      nested: {
        authorization: 'Bearer synthetic-bearer-value',
        clientSecret: 'synthetic-client-secret',
        note: 'Use sk-proj-synthetic-12345678901234567890 only in the provider.',
      },
      rows: Array.from({ length: 100 }, (_, index) => `value-${index}`),
    };

    const audit = redactMcpArgumentsForAudit(input);
    input.nested.note = 'mutated';

    expect(audit).toMatchObject({
      query: 'recent invoices',
      password: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        clientSecret: '[REDACTED]',
        note: 'Use [REDACTED] only in the provider.',
      },
    });
    expect(JSON.stringify(audit).length).toBeLessThan(24_000);
    expect(JSON.stringify(audit)).not.toContain('synthetic-password');
    expect(JSON.stringify(audit)).not.toContain('sk-proj-');
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen((audit as { nested: object }).nested)).toBe(true);
  });

  it('redacts a secret that crosses the audit truncation boundary', () => {
    const audit = redactMcpArgumentsForAudit({
      note: `${'x'.repeat(500)} sk-proj-synthetic-boundary-secret-1234567890`,
    });

    expect(JSON.stringify(audit)).not.toContain('sk-proj-');
    expect(JSON.stringify(audit)).not.toContain('synthetic-boundary');
    expect(JSON.stringify(audit).length).toBeLessThan(1_000);
  });

  it('reports structured-value truncation separately from the redacted value', () => {
    const result = redactMcpArgumentsForAuditWithStats({
      rows: Array.from({ length: 40 }, (_, index) => ({
        index,
        body: `row-${index}-${'x'.repeat(700)}`,
      })),
    });

    expect(result.value.rows).toHaveLength(24);
    expect(result.truncatedValues).toBeGreaterThan(0);
    expect(JSON.stringify(result.value)).not.toContain('synthetic');
  });
});
