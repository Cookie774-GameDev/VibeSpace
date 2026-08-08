import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OVERSIZED_CHAT_ATTACHMENT_RETENTION_MS,
  OVERSIZED_CHAT_TEXT_THRESHOLD,
  cleanupExpiredOversizedMessageAttachments,
  createOversizedMessageAttachment,
  oversizedMessageSummary,
  resetOversizedAttachmentCleanupForTests,
} from './oversizedMessageAttachment';

describe('oversized message attachments', () => {
  beforeEach(resetOversizedAttachmentCleanupForTests);

  it('keeps ordinary text inline and creates a native file only above the high threshold', async () => {
    const bridge = {
      create: vi.fn(async () => ({
        path: 'C:\\cache\\vibespace-chat-1.txt',
        name: 'vibespace-chat-1.txt',
        expiresAt: Date.now() + OVERSIZED_CHAT_ATTACHMENT_RETENTION_MS,
      })),
      cleanup: vi.fn(async () => 0),
    };
    await expect(
      createOversizedMessageAttachment('a'.repeat(OVERSIZED_CHAT_TEXT_THRESHOLD), bridge, true),
    ).resolves.toBeNull();
    await expect(
      createOversizedMessageAttachment('a'.repeat(OVERSIZED_CHAT_TEXT_THRESHOLD + 1), bridge, true),
    ).resolves.toMatchObject({ name: 'vibespace-chat-1.txt' });
    expect(bridge.create).toHaveBeenCalledTimes(1);
  });

  it('uses a compact transcript summary and starts cleanup only once per app session', () => {
    const bridge = {
      create: vi.fn(),
      cleanup: vi.fn(async () => 2),
    };
    cleanupExpiredOversizedMessageAttachments(bridge, true);
    cleanupExpiredOversizedMessageAttachments(bridge, true);
    expect(bridge.cleanup).toHaveBeenCalledTimes(1);
    expect(
      oversizedMessageSummary({
        path: 'C:\\cache\\vibespace-chat-1.txt',
        name: 'vibespace-chat-1.txt',
        expiresAt: 1,
      }),
    ).toMatch(/Long message attached.*expires after 24 hours/s);
  });
});
