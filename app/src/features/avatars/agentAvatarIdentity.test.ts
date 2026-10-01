import { describe, expect, it } from 'vitest';
import { agentAvatarIdentityForMessage } from './agentAvatarIdentity';

describe('agent avatar identity', () => {
  it('keeps unresolved assistant messages on one identity across chats and requests', () => {
    expect(
      agentAvatarIdentityForMessage({ role: 'assistant', agent_id: 'request-a' as never }),
    ).toBe('jarvis');
    expect(
      agentAvatarIdentityForMessage({ role: 'assistant', agent_id: 'request-b' as never }),
    ).toBe('jarvis');
  });

  it('uses a known agent slug and preserves an unresolved distinct agent', () => {
    expect(
      agentAvatarIdentityForMessage(
        { role: 'assistant', agent_id: 'request-a' as never },
        { slug: 'coder' },
      ),
    ).toBe('coder');
    expect(agentAvatarIdentityForMessage({ role: 'agent', agent_id: 'agent-a' as never })).toBe(
      'agent-a',
    );
  });
});
