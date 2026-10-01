import { describe, expect, it } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import {
  SECRET_CLASSES,
  applySecretPolicy,
  detectSecrets,
  hasDetectedSecret,
} from './secretDetector';

const GITHUB_TOKEN_FIXTURE = syntheticCredentialFixture(
  'ghp_',
  'SyntheticCredentialValue1234567890',
);
const STRIPE_KEY_FIXTURE = syntheticCredentialFixture('sk_test_', 'syntheticMaterial123456');

describe('unified secret detector', () => {
  it('covers every approved secret class without returning secret values', () => {
    const samples = [
      ['credentials', 'credential: synthetic-login-material'],
      [
        'private_key',
        '-----BEGIN PRIVATE KEY-----\nc3ludGhldGljLWtleS1tYXRlcmlhbA==\n-----END PRIVATE KEY-----',
      ],
      ['token', GITHUB_TOKEN_FIXTURE],
      ['password', 'password=hunter2-synthetic-value'],
      ['connection_string', 'postgres://user:synthetic-pass@localhost:5432/app'],
      ['signing_material', 'signing_key=synthetic-signing-material-123456'],
      ['environment_secret', `STRIPE_SECRET_KEY=${STRIPE_KEY_FIXTURE}`],
      ['high_entropy_candidate', 'mJ8vQ2xN7pL4sR9tW3yK6dF1hB5cG0zA'],
    ] as const;

    expect(SECRET_CLASSES).toEqual(samples.map(([secretClass]) => secretClass));
    for (const [secretClass, text] of samples) {
      const findings = detectSecrets(text);
      expect(findings.some((finding) => finding.secretClass === secretClass)).toBe(true);
      expect(JSON.stringify(findings)).not.toContain(
        text.slice(findings[0]!.start, findings[0]!.end),
      );
    }
  });

  it('supports explicit exclude, redact, and ask decisions', () => {
    const text = `Deploy with token=${GITHUB_TOKEN_FIXTURE} today.`;

    expect(applySecretPolicy(text, 'exclude')).toMatchObject({
      decision: 'excluded',
      text: undefined,
      requiresUserDecision: false,
    });
    const redacted = applySecretPolicy(text, 'redact');
    expect(redacted).toMatchObject({
      decision: 'redacted',
      requiresUserDecision: false,
    });
    expect(redacted.text).toContain('[redacted:token]');
    expect(redacted.text).not.toContain('ghp_');
    expect(applySecretPolicy(text, 'ask')).toMatchObject({
      decision: 'ask',
      text: undefined,
      requiresUserDecision: true,
    });
  });

  it('allows ordinary prose, commit hashes, UUIDs, and low-entropy identifiers', () => {
    for (const text of [
      'A normal project note with no credentials.',
      'commit 0123456789abcdef0123456789abcdef01234567',
      'request 123e4567-e89b-12d3-a456-426614174000',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]) {
      expect(hasDetectedSecret(text)).toBe(false);
      expect(applySecretPolicy(text, 'redact')).toMatchObject({
        decision: 'allowed',
        text,
      });
    }
  });

  it('flags high-entropy credentials that use three character classes without digits', () => {
    expect(detectSecrets('AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl+/')).toEqual([
      expect.objectContaining({
        secretClass: 'high_entropy_candidate',
        confidence: 'candidate',
      }),
    ]);
  });

  it('rejects a truncated private-key block before it can be persisted', () => {
    const text = '-----BEGIN PRIVATE KEY-----\ntruncated-key-material';
    expect(detectSecrets(text)).toEqual([
      expect.objectContaining({
        secretClass: 'private_key',
        confidence: 'high',
      }),
    ]);
    const redacted = applySecretPolicy(text, 'redact');
    expect(redacted.text).toBe('[redacted:private_key]');
    expect(redacted.text).not.toContain('truncated-key-material');
  });

  it('fails closed when the scan or finding boundary is reached', () => {
    const beyondScan = `${'safe'.repeat(262_145)}password=synthetic-secret-value`;
    expect(hasDetectedSecret(beyondScan)).toBe(true);
    const scanRedaction = applySecretPolicy(beyondScan, 'redact');
    expect(scanRedaction.decision).toBe('redacted');
    expect(scanRedaction.text).not.toContain('synthetic-secret-value');

    const overflow = Array.from(
      { length: 110 },
      (_, index) =>
        `token=${syntheticCredentialFixture(
          'ghp_',
          `SyntheticCredentialValue${String(index).padStart(20, '0')}`,
        )}`,
    ).join('\n');
    const overflowRedaction = applySecretPolicy(overflow, 'redact');
    expect(detectSecrets(overflow).length).toBeLessThanOrEqual(100);
    expect(overflowRedaction.text).not.toContain('ghp_');
  });

  it('bounds hostile input and returns deterministic non-overlapping findings', () => {
    const text = `${'safe '.repeat(220_000)}token=${GITHUB_TOKEN_FIXTURE}`;
    const first = detectSecrets(text);
    const second = detectSecrets(text);

    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(100);
    for (let index = 1; index < first.length; index += 1) {
      expect(first[index]!.start).toBeGreaterThanOrEqual(first[index - 1]!.end);
    }
  });
});
