import { describe, expect, it } from 'vitest';
import {
  detectExplicitVoiceAgentSlug,
  detectVoiceMention,
  isJarvisChat,
  voiceMessageTextForAgentRoute,
} from './voiceChatRouting';
import type { Agent, Chat } from '@/types';

const jarvisAgent = {
  id: 'agent-jarvis',
  slug: 'jarvis',
  name: 'Jarvis',
} as Agent;

const criticAgent = {
  id: 'agent-critic',
  slug: 'critic',
  name: 'Critic',
} as Agent;

const agents = {
  [jarvisAgent.id]: jarvisAgent,
  [criticAgent.id]: criticAgent,
};

describe('voiceChatRouting detection', () => {
  it('treats empty active_agent_ids as a Jarvis chat', () => {
    const chat = { active_agent_ids: [] } as unknown as Chat;
    expect(isJarvisChat(chat, agents)).toBe(true);
  });

  it('treats critic-bound chats as non-Jarvis', () => {
    const chat = { active_agent_ids: [criticAgent.id] } as unknown as Chat;
    expect(isJarvisChat(chat, agents)).toBe(false);
  });

  it('defaults generic utterances to Jarvis (no explicit agent)', () => {
    expect(detectExplicitVoiceAgentSlug('open five terminals')).toBeNull();
    expect(detectExplicitVoiceAgentSlug('hey Jarvis what is up')).toBeNull();
  });

  it('routes ask-the-agent phrasing to the named specialist', () => {
    expect(detectExplicitVoiceAgentSlug('ask the critic to review this')).toBe('critic');
    expect(voiceMessageTextForAgentRoute('ask the critic to review this', 'critic')).toBe(
      'to review this',
    );
  });

  it('routes @mentions to specialists but ignores @jarvis', () => {
    expect(detectVoiceMention('@critic fix the intro')).toBe('critic');
    expect(detectExplicitVoiceAgentSlug('@critic fix the intro')).toBe('critic');
    expect(detectExplicitVoiceAgentSlug('@jarvis summarize')).toBeNull();
  });

  it('routes dictation-into-agent phrasing', () => {
    expect(detectExplicitVoiceAgentSlug('type into critic the new paragraph')).toBe('critic');
    expect(
      voiceMessageTextForAgentRoute('type into critic the new paragraph', 'critic'),
    ).toBe('the new paragraph');
  });
});
