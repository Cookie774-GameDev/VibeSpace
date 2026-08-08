import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'runtime.ts'), 'utf8');

describe('Jarvis spawn/coordination overlay', () => {
  it('teaches concrete agent.run / run_many / chat.send and forbids fake spawns', () => {
    expect(source).toContain('agent.run');
    expect(source).toContain('agent.run_many');
    expect(source).toContain('chat.send');
    expect(source).toContain('Never claim you spawned subagents unless you emitted');
    expect(source).toContain('stay awake as supervisor');
    expect(source).toContain('/agent opens a live subagent thread selector');
  });
});
