import { describe, expect, it } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';

import { containsAllAboutMeSecret, sanitizeAllAboutMeMarkdown } from './allAboutMeSecurity';

describe('All About Me secret policy', () => {
  it('uses the unified detector for every secret-bearing profile line', () => {
    const markdown = [
      '# All About Me',
      'I build privacy-conscious developer tools.',
      'Database: postgres://user:synthetic-pass@localhost:5432/app',
      'Signing key=synthetic-signing-material-123456',
      'Credential candidate: AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl+/',
      '-----BEGIN PRIVATE KEY-----',
      'c3ludGhldGljLWtleS1tYXRlcmlhbA==',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    expect(containsAllAboutMeSecret(markdown)).toBe(true);
    expect(sanitizeAllAboutMeMarkdown(markdown)).toBe(
      '# All About Me\nI build privacy-conscious developer tools.',
    );
  });

  it('preserves ordinary profile prose, commit hashes, and UUIDs', () => {
    const markdown = [
      '# All About Me',
      'I use a password manager and prefer local-first software.',
      'Favorite commit: 0123456789abcdef0123456789abcdef01234567',
      'Workspace ID: 123e4567-e89b-12d3-a456-426614174000',
    ].join('\n');

    expect(containsAllAboutMeSecret(markdown)).toBe(false);
    expect(sanitizeAllAboutMeMarkdown(markdown)).toBe(markdown);
  });

  it('removes an entire truncated private key without retaining its body', () => {
    const markdown = [
      '# All About Me',
      'Safe profile line.',
      '-----BEGIN PRIVATE KEY-----',
      'short-key-body',
    ].join('\n');

    expect(sanitizeAllAboutMeMarkdown(markdown)).toBe('# All About Me\nSafe profile line.');
  });

  it('preserves safe lines around an environment secret', () => {
    const markdown = [
      '# All About Me',
      'Keep this line.',
      'API_SECRET=synthetic-secret-value',
      'Keep this line too.',
    ].join('\n');

    expect(sanitizeAllAboutMeMarkdown(markdown)).toBe(
      '# All About Me\nKeep this line.\nKeep this line too.',
    );
  });

  it('fails closed after the bounded finding limit without retaining later secrets', () => {
    const secretLines = Array.from(
      { length: 110 },
      (_, index) =>
        `token=${syntheticCredentialFixture(
          'ghp_',
          `SyntheticCredentialValue${String(index).padStart(20, '0')}`,
        )}`,
    );
    const sanitized = sanitizeAllAboutMeMarkdown(
      ['# All About Me', 'Safe before.', ...secretLines].join('\n'),
    );

    expect(sanitized).toBe('# All About Me\nSafe before.');
    expect(sanitized).not.toContain('ghp_');
  });
});
