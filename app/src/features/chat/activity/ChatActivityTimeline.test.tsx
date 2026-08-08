import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityRow, ChatActivityTimeline, summarizeChatActivity } from './ChatActivityTimeline';
import { useChatActivityStore } from './activityStore';
import type { ChatActivityEvent } from './types';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import { chatActivityPreferences } from './chatActivityPreferences';

describe('ChatActivityTimeline always-visible session panel', () => {
  beforeEach(() => {
    useChatActivityStore.setState({ eventsByChat: {} });
    useJarvisTaskRunStore.getState().clearForTests();
    chatActivityPreferences.setShowSessionPanel(true);
  });

  it('renders the Jarvis session dashboard even with no activity events', () => {
    render(<ChatActivityTimeline chatId="chat_empty" />);

    const panel = screen.getByTestId('jarvis-session-panel');
    expect(panel).toBeTruthy();
    expect(panel.className).toContain('shadow-soft');
    expect(panel.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(screen.getByLabelText('Jarvis session')).toBeTruthy();
    expect(screen.getByText('Jarvis session')).toBeTruthy();
    expect(screen.getByText(/Ready — send a message/i)).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
  });

  it('summarizes empty sessions as ready (not blank)', () => {
    const summary = summarizeChatActivity([]);
    expect(summary.eventCount).toBe(0);
    expect(summary.isLive).toBe(false);
    expect(summary.doingNow).toMatch(/Ready/i);
  });

  it('reads only the bounded canonical activity projection for the selected chat', () => {
    const legacyOnly: ChatActivityEvent = {
      id: 'legacy-event',
      chatId: 'chat-canonical',
      kind: 'agent',
      status: 'running',
      title: 'Legacy lifecycle writer event',
      ts: 1,
    };
    useChatActivityStore.getState().record(legacyOnly);
    const canonical = Array.from(
      { length: 20 },
      (_, index): ChatActivityEvent => ({
        id: `canonical-${index}`,
        chatId: 'chat-canonical',
        kind: 'tool',
        status: index === 19 ? 'running' : 'done',
        title: `Canonical event ${index}`,
        detail: `Canonical safe detail ${index}`,
        ts: index + 10,
      }),
    );
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceCanonicalForAccount('scope-alpha', [], {
      'chat-canonical': canonical,
    });

    render(<ChatActivityTimeline chatId="chat-canonical" />);

    expect(screen.getByText('Canonical safe detail 19')).toBeTruthy();
    expect(screen.queryByText('Legacy lifecycle writer event')).toBeNull();
    expect(screen.queryByText('Canonical event 0')).toBeNull();
  });
});

describe('ActivityRow', () => {
  it('renders Edit-style file cards with line counts and expands the diff on click', () => {
    const event: ChatActivityEvent = {
      id: 'diff_1',
      chatId: 'chat_1',
      kind: 'diff',
      status: 'done',
      title: 'Wrote file',
      subtitle: 'src/App.tsx',
      filePath: 'src/App.tsx',
      addedLines: 8,
      removedLines: 2,
      diff: '+new code\n-old code',
      ts: 1,
    };

    render(<ActivityRow event={event} />);

    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.getByText('+8')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    expect(screen.queryByText((content) => content.includes('+new code'))).toBeNull();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText((content) => content.includes('+new code'))).toBeTruthy();
  });

  it('renders AllAboutMe learning file writes as Edit cards with diff counts', () => {
    const event: ChatActivityEvent = {
      id: 'diff_all_about_me',
      chatId: 'chat_1',
      kind: 'diff',
      status: 'done',
      title: 'AllAboutMe.md file written',
      subtitle: 'VibeSpace Profile Vault/AllAboutMe.md',
      filePath: 'VibeSpace Profile Vault/AllAboutMe.md',
      addedLines: 3,
      removedLines: 1,
      diff: '--- AllAboutMe.md\n+++ AllAboutMe.md\n-old\n+new',
      ts: 1,
    };

    render(<ActivityRow event={event} />);

    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('AllAboutMe.md')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });
});
