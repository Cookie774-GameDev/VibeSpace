import { describe, expect, it } from 'vitest';
import { chatNotificationCopy } from './chatNotificationPresentation';

describe('chat notification copy', () => {
  it.each(['completed', 'failed', 'stopped'] as const)(
    'uses chat and task names for %s',
    (status) => {
      const copy = chatNotificationCopy({
        status,
        agentName: 'Jarvis',
        chatTitle: 'Design review',
        taskText: 'Polish the Workbench',
      });
      expect(copy.title).toContain('Polish the Workbench');
      expect(copy.body).toContain('Chat: Design review.');
      expect(Array.from(copy.title).length).toBeLessThanOrEqual(64);
      expect(Array.from(copy.body).length).toBeLessThanOrEqual(112);
    },
  );

  it('bounds long Unicode text without splitting characters or squishing the toast', () => {
    const copy = chatNotificationCopy({
      status: 'completed',
      agentName: 'Jarvis',
      chatTitle: '✨'.repeat(100),
      taskText: '🪐'.repeat(100),
    });
    expect(copy.title).toMatch(/^Finished: 🪐+…$/u);
    expect(Array.from(copy.title).length).toBe(64);
    expect(Array.from(copy.body).length).toBeLessThanOrEqual(112);
  });

  it('omits placeholder and secret-bearing names', () => {
    const copy = chatNotificationCopy({
      status: 'failed',
      agentName: 'Jarvis',
      chatTitle: 'New chat 2',
      taskText: `Use ${['sk', 'proj', '12345678901234567890'].join('-')}`,
    });
    expect(copy).toEqual({
      title: 'Failed: Jarvis',
      body: 'Open VibeSpace to review the failure.',
    });
  });
});
