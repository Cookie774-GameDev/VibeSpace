import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {},
  chatRepo: { getById: vi.fn() },
  messageRepo: { listByChat: vi.fn() },
}));

vi.mock('@/features/browser-chat/chatGptExport', () => ({
  createChatGptSnapshotRepository: () => ({
    get: mocks.getSnapshot,
  }),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a',
    }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({ setActiveChat: vi.fn(), setRoute: vi.fn() }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({ agents: {} }),
}));

import { Replay } from './Replay';

describe('Replay imported provider snapshots', () => {
  it('renders imported messages as inert local text with explicit authority labeling', async () => {
    mocks.getSnapshot.mockResolvedValueOnce({
      id: 'snapshot-a',
      title: 'Imported <script>alert(1)</script>',
      provider: 'chatgpt',
      revision: 2,
      updatedAt: 20,
      messages: [
        { id: 'message-a', role: 'user', text: 'Literal <img src=x onerror=alert(1)>' },
        { id: 'message-b', role: 'assistant', text: 'Safe response' },
      ],
    });

    render(<Replay chatId={null} snapshotId="snapshot-a" />);

    await waitFor(() => expect(screen.getByText(/Imported <script>alert/)).toBeTruthy());
    expect(screen.getByText('Literal <img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('Safe response')).toBeTruthy();
    expect(screen.getByText(/local snapshot.*does not fetch live provider content/i)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('never introduces an HTML injection rendering path', () => {
    const source = readFileSync(resolve(__dirname, 'Replay.tsx'), 'utf8');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
