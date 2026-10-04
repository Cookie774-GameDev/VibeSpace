import { describe, expect, it } from 'vitest';
import { getClassifiedPluginManifest } from './catalog';
import {
  completePluginAuthorizationManifest,
  verifiedProviderAuthorizationUrl,
} from './authorizationCapability';

describe('plugin authorization capability', () => {
  it('accepts only the exact registered provider-hosted endpoint', () => {
    const github = getClassifiedPluginManifest('github');
    expect(github?.authorizationCapability.kind).toBe('provider_hosted_oauth');
    if (!github) {
      throw new Error('GitHub authorization classification is unavailable.');
    }
    const capability = github.authorizationCapability;

    expect(verifiedProviderAuthorizationUrl(capability, 'https://github.com/login/device')).toBe(
      'https://github.com/login/device',
    );

    for (const candidate of [
      undefined,
      'http://github.com/login/device',
      'https://user:password@github.com/login/device',
      'https://github.com/login/device#token',
      'https://github.com/login/device?client_id=invented',
      'https://accounts.example.test/authorize',
    ]) {
      expect(() => verifiedProviderAuthorizationUrl(capability, candidate)).toThrow(
        /unverified authorization endpoint/i,
      );
    }
  });

  it('never upgrades a manual connector into provider-hosted authorization', () => {
    const gmail = getClassifiedPluginManifest('gmail');
    expect(gmail?.authorizationCapability.kind).toBe('manual_fallback');
    if (!gmail) {
      throw new Error('Gmail authorization classification is unavailable.');
    }
    const capability = gmail.authorizationCapability;

    expect(() =>
      verifiedProviderAuthorizationUrl(capability, 'https://accounts.google.com/o/oauth2/v2/auth'),
    ).toThrow(/not available/i);
  });

  it('describes Supabase hosted MCP as a separate OpenCode connection', () => {
    const supabase = getClassifiedPluginManifest('supabase');
    expect(supabase?.authorizationCapability).toMatchObject({
      kind: 'external_blocker',
      providerAccessUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
    });
    expect(supabase?.authorizationCapability).toHaveProperty(
      'reason',
      expect.stringMatching(/hosted MCP.*OpenCode.*separate.*API/i),
    );
    expect(JSON.stringify(supabase?.authorizationCapability)).toMatch(
      /project API key.*does not authorize the hosted MCP/i,
    );
  });

  it('fails a misconfigured registered provider back to an explicit blocker', () => {
    const github = getClassifiedPluginManifest('github');
    if (!github) {
      throw new Error('GitHub authorization classification is unavailable.');
    }
    const { authorizationCapability: _authorizationCapability, ...draft } = github;

    const mismatched = completePluginAuthorizationManifest({
      ...draft,
      authorizationUrl: 'https://github.com/settings/personal-access-tokens',
    });

    expect(mismatched.authorizationCapability).toMatchObject({
      kind: 'external_blocker',
    });
    expect(mismatched.providerAccessUrl).toBe(github.credentialUrl);
  });
});
