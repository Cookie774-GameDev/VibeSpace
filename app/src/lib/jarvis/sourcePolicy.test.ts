import { describe, expect, it } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';

import {
  classifyJarvisReadError,
  classifyJarvisSource,
  isJarvisModelVisibleSchemaSafe,
} from './sourcePolicy';

const privateText = (path: string, overrides: Record<string, unknown> = {}) => ({
  path,
  root: path.includes('\\') ? 'C:\\repo' : '/repo',
  channel: 'automatic_scan' as const,
  kind: 'text' as const,
  ...overrides,
});

describe('classifyJarvisSource path admission', () => {
  it.each(['C:\\repo\\.env', 'C:\\repo\\.ENV.local', '/repo/.npmrc', '/repo/.pypirc'])(
    'rejects environment and package credential files: %s',
    (path) => {
      expect(classifyJarvisSource(privateText(path))).toMatchObject({
        allowed: false,
        reason: 'secret_filename',
      });
    },
  );

  it.each([
    '/repo/certs/signing.pem',
    'C:\\repo\\certs\\client.KEY',
    '/repo/certs/export.p12',
    'C:\\repo\\certs\\export.pfx',
    '/repo/keys/private-key-export.txt',
    'C:\\repo\\.ssh\\id_rsa',
    '/repo/.ssh/id_ed25519',
  ])('rejects private key material: %s', (path) => {
    expect(classifyJarvisSource(privateText(path))).toMatchObject({ allowed: false });
  });

  it.each([
    '/repo/.aws/credentials',
    'C:\\repo\\.aws\\credentials',
    '/repo/.credentials/session.json',
    '/repo/.config/gcloud/application_default_credentials.json',
    'C:\\repo\\.azure\\accessTokens.json',
    '/repo/.codex/auth.json',
    'C:\\repo\\.claude\\.credentials.json',
    '/repo/.gemini/oauth_creds.json',
    'C:\\repo\\.config\\openai\\auth.json',
    '/repo/.config/opencode/auth.json',
    'C:\\repo\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data',
    '/repo/.config/chromium/Default/Login Data',
    'C:\\repo\\.mozilla\\firefox\\profile\\logins.json',
    '/repo/.config/gh/hosts.yml',
    'C:\\repo\\.docker\\config.json',
    '/repo/.kube/config',
    'C:\\repo\\secrets\\notes.txt',
    '/repo/credentials/export.json',
  ])('rejects credential paths and directories: %s', (path) => {
    expect(classifyJarvisSource(privateText(path))).toMatchObject({
      allowed: false,
      reason: 'credential_path',
    });
  });

  it.each([
    '/repo/exports/recovery-codes.txt',
    'C:\\repo\\exports\\login.keychain-db',
    '/repo/browser/Cookies',
    'C:\\repo\\auth-store\\sessions.json',
  ])('rejects exported recovery, keychain, cookie, and auth data: %s', (path) => {
    expect(classifyJarvisSource(privateText(path))).toMatchObject({ allowed: false });
  });

  it.each([
    '/repo/src/environment.ts',
    'C:\\repo\\docs\\cookie-policy.md',
    '/repo/src/keynote.ts',
    '/repo/src/auth.ts',
    'C:\\repo\\docs\\opencode-auth.md',
    '/repo/src/login-data-view.ts',
  ])('allows safe near-matches: %s', (path) => {
    expect(classifyJarvisSource(privateText(path))).toMatchObject({
      allowed: true,
      reason: 'allowed_text_source',
      sensitivity: 'private',
    });
  });

  it.each(['/repo/docs/private-key-rotation.md', 'C:\\repo\\docs\\private-key-policy.md'])(
    'allows benign private-key documentation: %s',
    (path) => {
      expect(classifyJarvisSource(privateText(path))).toMatchObject({
        allowed: true,
        reason: 'allowed_text_source',
      });
    },
  );

  it('rejects lexical traversal and absolute paths outside the selected root before native access', () => {
    expect(classifyJarvisSource(privateText('C:\\repo\\..\\outside\\notes.txt'))).toMatchObject({
      allowed: false,
      reason: 'outside_allowed_root',
    });
    expect(
      classifyJarvisSource(
        privateText('/outside/hero.png', {
          root: '/repo',
          kind: 'media_metadata',
        }),
      ),
    ).toMatchObject({ allowed: false, reason: 'outside_allowed_root' });
  });

  it('allows legitimate children beneath filesystem roots', () => {
    expect(classifyJarvisSource(privateText('/repo/readme.md', { root: '/' }))).toMatchObject({
      allowed: true,
    });
    expect(
      classifyJarvisSource(privateText('C:\\repo\\readme.md', { root: 'C:\\' })),
    ).toMatchObject({ allowed: true });
  });

  it('denies unsupported shapes and files over the native cap', () => {
    expect(
      classifyJarvisSource(privateText('/repo/archive.bin', { kind: 'binary' })),
    ).toMatchObject({
      allowed: false,
      reason: 'binary',
    });
    expect(classifyJarvisSource(privateText('/repo/unknown', { kind: 'unknown' }))).toMatchObject({
      allowed: false,
      reason: 'unsupported',
    });
    expect(
      classifyJarvisSource(privateText('/repo/huge.txt', { sizeBytes: 100 * 1024 * 1024 + 1 })),
    ).toMatchObject({
      allowed: false,
      reason: 'too_large',
    });
  });
});

describe('classifyJarvisSource content admission', () => {
  const githubToken = syntheticCredentialFixture('ghp_', '1234567890abcdefghijkl');
  const googleKey = syntheticCredentialFixture('AIza', '1234567890abcdefghijkl');

  it.each([
    '-----BEGIN PRIVATE KEY-----\nsynthetic-secret\n-----END PRIVATE KEY-----',
    'API_KEY=synthetic-secret',
    'ACCESS_TOKEN: synthetic-secret',
    'REFRESH_TOKEN = synthetic-secret',
    'CLIENT_SECRET=synthetic-secret',
    'PASSWORD=synthetic-secret',
    'AWS_SECRET_ACCESS_KEY=synthetic-secret',
    'token: github_pat_1234567890abcdefghijkl',
    `token=${githubToken}`,
    'apiKey: sk-1234567890abcdef',
    `googleKey=${googleKey}`,
    'Recovery Codes\n1234-5678\n8765-4321',
    'credential export\nusername: alice\npassword: synthetic-secret',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nsynthetic-private-material',
    'const CLIENT_SECRET = "synthetic-secret";',
    "let API_KEY: string = 'synthetic-secret';",
    'var PASSWORD = `synthetic-secret`;',
    '{"PASSWORD":"synthetic-secret"}',
    '{"ACCESS_TOKEN":"abcdefghijklmnopqrstuvwxyz123456"}',
    '{"openai_api_key":"abcdefghijklmnopqrstuvwxyz123456"}',
    'ANTHROPIC_CLIENT_SECRET: abcdefghijklmnopqrstuvwxyz123456',
    '{"recovery_codes":["ABCD EFGH IJKL","MNOP QRST UVWX"]}',
    '{"credential_export":{"token":"abcdefghijklmnopqrstuvwxyz123456"}}',
    'token=sk-1234567890abcdef',
  ])('rejects secret-bearing content without reflecting the matched value', (contentSample) => {
    const decision = classifyJarvisSource(privateText('C:\\repo\\notes.txt', { contentSample }));
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'secret_content',
      sensitivity: 'secret',
    });
    expect(decision.safeSummary).not.toContain('synthetic-secret');
    expect(decision.safeSummary).not.toContain('SyntheticSecret');
    expect(decision.safeSummary).not.toContain('C:\\repo');
  });

  it('does not treat short prefix examples or unassigned variable names as credentials', () => {
    for (const contentSample of [
      'The OPENAI_API_KEY environment variable is documented here without a value.',
      'example = sk-short',
      `prefix${githubToken} is explanatory prose`,
      'const CLIENT_SECRET = process.env.CLIENT_SECRET;',
      "const API_KEY = '';",
      '{"PASSWORD":""}',
    ]) {
      expect(
        classifyJarvisSource(privateText('/repo/docs/security.md', { contentSample })),
      ).toMatchObject({ allowed: true });
    }
  });

  it('uses a generic single-line summary when a rejected basename is token or control shaped', () => {
    for (const path of [`C:\\repo\\${githubToken}.txt`, '/repo/line\nbreak.txt']) {
      const decision = classifyJarvisSource(
        privateText(path, {
          root: path.includes('\\') ? 'C:\\repo' : '/repo',
          contentSample: 'PASSWORD=abcdefghijklmnopqrstuvwxyz123456',
        }),
      );
      expect(decision).toMatchObject({ allowed: false, reason: 'secret_content' });
      expect(decision.safeSummary).not.toContain(githubToken);
      expect(decision.safeSummary).not.toContain('line');
      expect(decision.safeSummary).not.toContain('break');
      expect(decision.safeSummary).not.toContain('\n');
      expect(decision.safeSummary).toMatch(/^source:/);
    }
  });

  it('defaults local inputs to private and returns public only when explicitly requested', () => {
    expect(classifyJarvisSource(privateText('/repo/readme.md'))).toMatchObject({
      sensitivity: 'private',
    });
    expect(
      classifyJarvisSource(privateText('/repo/readme.md', { defaultSensitivity: 'public' })),
    ).toMatchObject({
      allowed: true,
      sensitivity: 'public',
    });
  });
});

describe('classifyJarvisReadError', () => {
  it.each([
    ['outside_root', 'outside_allowed_root'],
    ['symlink_blocked', 'outside_allowed_root'],
    ['other_user_folder', 'outside_allowed_root'],
    ['too_large', 'too_large'],
    ['not_utf8', 'binary'],
    ['unsupported_type', 'unsupported'],
  ] as const)('maps %s to %s without reflecting raw filesystem details', (code, reason) => {
    const decision = classifyJarvisReadError({ code, raw: 'C:\\private\\synthetic-secret' });
    expect(decision).toMatchObject({ allowed: false, reason });
    expect(decision.safeSummary).not.toContain('synthetic-secret');
    expect(decision.safeSummary).not.toContain('C:\\private');
  });
});

describe('isJarvisModelVisibleSchemaSafe', () => {
  it('accepts detached JSON schema metadata without credential material', () => {
    expect(
      isJarvisModelVisibleSchemaSafe({
        id: 'terminal.run',
        description: 'Run a command after the required approval.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            mode: { type: 'string', enum: ['foreground', 'background'] },
          },
          required: ['command'],
          additionalProperties: false,
        },
      }),
    ).toBe(true);
  });

  it('rejects secret-bearing string leaves after JSON detachment', () => {
    const secretAssignment = ['CLIENT', 'SECRET=synthetic-secret'].join('_');
    expect(
      isJarvisModelVisibleSchemaSafe({
        inputSchema: {
          type: 'object',
          description: secretAssignment,
        },
      }),
    ).toBe(false);
  });

  it.each([
    ['client', 'Secret'],
    ['aws', 'SecretAccessKey'],
    ['authorization'],
    ['cookie'],
    ['recovery', 'Code'],
  ])('rejects credential-shaped model-visible field names: %s', (...segments) => {
    const credentialField = segments.join('');
    expect(
      isJarvisModelVisibleSchemaSafe({
        type: 'object',
        properties: {
          [credentialField]: { type: 'string' },
        },
      }),
    ).toBe(false);
  });

  it('rejects non-JSON object behavior and cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'description', {
      enumerable: true,
      get: () => 'hidden behavior',
    });

    expect(isJarvisModelVisibleSchemaSafe(cyclic)).toBe(false);
    expect(isJarvisModelVisibleSchemaSafe(accessor)).toBe(false);
    expect(isJarvisModelVisibleSchemaSafe(new Date(0))).toBe(false);
  });
});
