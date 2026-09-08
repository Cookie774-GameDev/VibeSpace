import { describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeChildControl } from './openCodeChildControls';

describe('OpenCode child control authority', () => {
  const event = (type = 'permission.asked', sessionID = 'child') => ({ type, properties: { sessionID } });
  it.each(['permission.asked', 'permission.updated', 'question.asked'])('accepts %s only after verifying the native parent chain', async type => {
    const lookup = vi.fn(async (id: string) => id === 'child'
      ? { id, parentID: 'reviewer' } : { id, parentID: 'root' });
    expect(await resolveOpenCodeChildControl(event(type), 'root', lookup)).toBe('child');
    expect(lookup.mock.calls).toEqual([['child'], ['reviewer']]);
  });
  it.each(['message.updated', 'message.part.updated', 'session.idle', 'session.error'])('does not merge child %s into the parent', async type => {
    const lookup = vi.fn();
    expect(await resolveOpenCodeChildControl(event(type), 'root', lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects foreign, mismatched, missing, cyclic, and unavailable session identities', async () => {
    for (const lookup of [
      async (id: string) => ({ id, parentID: 'foreign' }),
      async () => ({ id: 'different', parentID: 'root' }),
      async () => ({ id: 'child' }),
      async () => { throw Error('unavailable'); },
    ]) expect(await resolveOpenCodeChildControl(event(), 'root', lookup)).toBeUndefined();
  });
  it('bounds parent traversal and rejects malformed session identifiers without lookup', async () => {
    const lookup = vi.fn(async (id: string) => ({ id, parentID: `${id}x` }));
    expect(await resolveOpenCodeChildControl(event(), 'root', lookup)).toBeUndefined();
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(8);
    lookup.mockClear();
    expect(await resolveOpenCodeChildControl(event('permission.asked', '../foreign'), 'root', lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
