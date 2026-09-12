import { describe, expect, it } from 'vitest';
import { buildUserIdentityContextBlock } from './userIdentity';

describe('buildUserIdentityContextBlock', () => {
  it('still requires sir when no display name is set', () => {
    const block = buildUserIdentityContextBlock('');
    expect(block).toContain('User identity');
    expect(block).toContain('Address the user as sir');
    expect(buildUserIdentityContextBlock(null)).toContain('sir');
    expect(buildUserIdentityContextBlock(undefined)).toContain('sir');
  });

  it('injects the settings display name and sir for every provider', () => {
    const block = buildUserIdentityContextBlock('Viper');
    expect(block).toContain('User identity');
    expect(block).toContain('**Viper**');
    expect(block).toContain('preferred name');
    expect(block).toContain('sir');
    expect(block).toContain('Yes, Viper — I can create that file, sir.');
  });

  it('truncates extremely long names', () => {
    const long = 'A'.repeat(200);
    const block = buildUserIdentityContextBlock(long);
    expect(block).toContain('**' + 'A'.repeat(80) + '**');
    expect(block).not.toContain('A'.repeat(81));
  });
});
