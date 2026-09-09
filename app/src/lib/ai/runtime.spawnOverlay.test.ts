import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'runtime.ts'), 'utf8');

describe('Jarvis spawn/coordination overlay', () => {
  it('requires native delegation and observed child activity', () => {
    expect(source).toContain('agent.run');
    expect(source).toContain('agent.run_many');
    expect(source).toContain('use the selected backend native delegation tools');
    expect(source).toContain('Do not substitute VibeSpace agent.run / agent.run_many actions');
    expect(source).toContain('Report only observed child activity and completion');
    expect(source).toContain('stay awake as supervisor');
    expect(source).toContain('/agent opens a live subagent thread selector');
  });
});
