import { describe, expect, it } from 'vitest';
import {
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_TARGET,
  catalogStats,
  validatePluginCatalog,
} from './catalog';

describe('plugin catalog', () => {
  it('contains 112 schema-valid verified connectors', () => {
    expect(PLUGIN_CATALOG.length).toBe(PLUGIN_CATALOG_TARGET);
    expect(PLUGIN_CATALOG.length).toBe(112);
    expect(validatePluginCatalog()).toEqual([]);
    expect(new Set(PLUGIN_CATALOG.map((plugin) => plugin.id)).size).toBe(PLUGIN_CATALOG.length);
  });

  it('only labels connectors with declared runtime tools as implemented', () => {
    const implemented = PLUGIN_CATALOG.filter((plugin) => plugin.status === 'implemented');
    expect(implemented.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        'github',
        'figma',
        'supabase',
        'shopify',
        'slack',
        'mock-connector',
        'gmail',
        'google-drive',
        'canva',
        'zapier',
      ]),
    );
    expect(implemented.every((plugin) => plugin.tools.length > 0)).toBe(true);
  });

  it('publishes Gmail as a fixed implemented provider with narrow desktop OAuth credentials', () => {
    const gmail = PLUGIN_CATALOG.find((plugin) => plugin.id === 'gmail');

    expect(gmail).toMatchObject({
      id: 'gmail',
      provider: 'Google',
      authType: 'oauth',
      status: 'implemented',
      fields: [
        { id: 'client_id', secret: false, required: true },
        { id: 'refresh_token', secret: true, required: true },
      ],
      supportedFeatures: [
        'message search',
        'message and thread reading',
        'drafts',
        'approved send',
      ],
      requiredScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
      tools: [
        { name: 'message_search', readOnly: true },
        { name: 'message_read', readOnly: true },
        { name: 'thread_read', readOnly: true },
        { name: 'draft_create', readOnly: false },
        { name: 'reply_draft_create', readOnly: false },
        { name: 'draft_send', readOnly: false },
      ],
    });
    expect(gmail?.limitations).toMatch(/restricted scopes|provider verification/i);
    expect(JSON.stringify(gmail)).not.toMatch(/client_secret/i);
  });

  it('publishes Google Drive as a fixed implemented provider with narrow desktop OAuth credentials', () => {
    const drive = PLUGIN_CATALOG.find((plugin) => plugin.id === 'google-drive');

    expect(drive).toMatchObject({
      id: 'google-drive',
      provider: 'Google',
      authType: 'oauth',
      status: 'implemented',
      fields: [
        { id: 'client_id', secret: false, required: true },
        { id: 'refresh_token', secret: true, required: true },
      ],
      supportedFeatures: [
        'file search',
        'selected document reading',
        'source links',
        'approved Google document creation',
      ],
      requiredScopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ],
      tools: [
        { name: 'files_search', readOnly: true },
        { name: 'document_read', readOnly: true },
        { name: 'document_create', readOnly: false },
      ],
    });
    expect(drive?.limitations).toMatch(/restricted scope|provider verification/i);
    expect(JSON.stringify(drive)).not.toMatch(/client_secret/i);
  });

  it('publishes Canva as a fixed implemented Connect API provider with rotating OAuth credentials', () => {
    const canva = PLUGIN_CATALOG.find((plugin) => plugin.id === 'canva');

    expect(canva).toMatchObject({
      id: 'canva',
      provider: 'Canva',
      authType: 'oauth',
      status: 'implemented',
      fields: [
        { id: 'client_id', secret: false, required: true },
        { id: 'client_secret', secret: true, required: true },
        { id: 'refresh_token', secret: true, required: true },
      ],
      supportedFeatures: [
        'design search and exact reads',
        'brand template search',
        'brand template dataset inspection',
        'approved preset design creation',
        'structured text autofill from eligible brand templates',
        'validated edit and view links',
      ],
      requiredScopes: [
        'profile:read',
        'design:meta:read',
        'design:content:write',
        'brandtemplate:meta:read',
        'brandtemplate:content:read',
      ],
      tools: [
        { name: 'designs_search', readOnly: true },
        { name: 'design_read', readOnly: true },
        { name: 'brand_templates_search', readOnly: true },
        { name: 'brand_template_dataset_read', readOnly: true },
        { name: 'autofill_job_read', readOnly: true },
        { name: 'design_create', readOnly: false },
        { name: 'design_autofill', readOnly: false },
      ],
    });
    expect(canva?.limitations).toMatch(/stable Connect API|provider review|autofill/i);
    expect(JSON.stringify(canva)).not.toMatch(/cnvca-|refresh-token/i);
  });

  it('publishes Zapier as a configured-action MCP gateway without broad app guarantees', () => {
    const zapier = PLUGIN_CATALOG.find((plugin) => plugin.id === 'zapier');

    expect(zapier).toMatchObject({
      id: 'zapier',
      provider: 'Zapier',
      authType: 'token',
      status: 'implemented',
      fields: [{ id: 'connection_token', secret: true, required: true }],
      supportedFeatures: [
        'configured action discovery',
        'exact selected action identity',
        'approved downstream action execution',
      ],
      tools: [
        { name: 'actions_discover', readOnly: true },
        { name: 'action_invoke', readOnly: false },
      ],
    });
    expect(zapier?.limitations).toMatch(/currently exposed|configured actions|task usage/i);
    expect(JSON.stringify(zapier)).not.toMatch(/9,?000|thousands of apps|connection-token/i);
  });

  it('excludes needs_credentials placeholders from the curated catalog', () => {
    expect(PLUGIN_CATALOG.every((plugin) => plugin.status !== 'needs_credentials')).toBe(true);
  });

  it('declares exact least-privilege scopes for every implemented OAuth connector', () => {
    const implementedOauth = PLUGIN_CATALOG.filter(
      (plugin) => plugin.status === 'implemented' && plugin.authType === 'oauth',
    );

    expect(implementedOauth.map((plugin) => plugin.id).sort()).toEqual([
      'canva',
      'github',
      'gmail',
      'google-drive',
    ]);
    expect(implementedOauth.every((plugin) => (plugin.requiredScopes?.length ?? 0) > 0)).toBe(true);
  });

  it('rejects implemented OAuth metadata with missing or duplicate scope disclosure', () => {
    const gmail = PLUGIN_CATALOG.find((plugin) => plugin.id === 'gmail');
    expect(gmail).toBeTruthy();

    expect(validatePluginCatalog([{ ...gmail!, requiredScopes: [] }])).toContain(
      'gmail: implemented OAuth plugin missing required scopes',
    );
    expect(
      validatePluginCatalog([
        {
          ...gmail!,
          requiredScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
          ],
        },
      ]),
    ).toContain('gmail: invalid required scopes');
  });

  it('reports catalog coverage stats', () => {
    const stats = catalogStats();
    expect(stats).toEqual({
      total: 112,
      implemented: 10,
      configurable: 102,
      needsCredentials: 0,
      blocked: 0,
      withHttpTest: 85,
    });
  });
});
