import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { WorkspaceId } from '@/types/common';
import type { EventRow } from '@/types/event';
import type { Task } from '@/types/task';
import type { RecurrenceInstance } from './recurrence';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

const scheduleState = vi.hoisted(() => ({
  jarvisEvents: [] as EventRow[],
  reducedMotion: false,
  timelineEvents: [] as RecurrenceInstance[],
  endedEvents: [] as RecurrenceInstance[],
  timelineTasks: [] as Task[],
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    useReducedMotion: () => scheduleState.reducedMotion,
  };
});

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    eventRepo: {
      create: vi.fn(),
      delete: vi.fn(),
      getById: vi.fn(),
    },
  };
});

vi.mock('@/features/tasks', () => ({
  completeTask: vi.fn(),
  useUpcomingTasks: () => scheduleState.timelineTasks,
}));

vi.mock('./hooks', () => ({
  useUpcomingEvents: () => scheduleState.timelineEvents,
  useRecentlyEndedEvents: () => scheduleState.endedEvents,
  useJarvisScheduleEvents: () => scheduleState.jarvisEvents,
}));

import { SchedulePage } from './SchedulePage';

function scheduledEvent(title: string): RecurrenceInstance {
  const now = Date.now();
  const event = {
    id: 'event_monochrome',
    workspace_id: 'workspace_1',
    title,
    start_at: now + 60_000,
    end_at: now + 3_660_000,
    all_day: false,
    timezone: 'UTC',
    attendees: [],
    source: 'manual',
    reminders: [],
    status: 'scheduled',
    created_by: 'usr_local',
    created_at: now,
    updated_at: now,
  } as unknown as EventRow;

  return {
    event,
    instanceStartMs: event.start_at,
    instanceEndMs: event.end_at,
    isRecurrence: false,
  };
}

describe('SchedulePage MonoChrome appearance', () => {
  beforeEach(() => {
    scheduleState.jarvisEvents = [];
    scheduleState.reducedMotion = false;
    scheduleState.timelineEvents = [];
    scheduleState.endedEvents = [];
    scheduleState.timelineTasks = [];
    document.documentElement.dataset.theme = 'monochrome';
    useAuthStore.setState({
      workspaceId: 'workspace_1' as WorkspaceId,
      localUserId: 'usr_local',
      apiKeys: { google: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: '',
      chatModelSelection: {
        mode: 'single',
        providerId: 'google',
        modelId: 'gemini-2.5-flash-lite',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    delete document.documentElement.dataset.theme;
  });

  it('keeps ordinary empty-state effects while making their MonoChrome paint deterministic', () => {
    render(<SchedulePage />);

    const route = screen
      .getByRole('heading', { name: 'Events, timed tasks, and AI plans' })
      .closest<HTMLElement>('[data-monochrome-route="schedule"]');
    const header = route?.querySelector<HTMLElement>('[data-monochrome-surface="schedule-header"]');
    const ambient = header?.querySelector<HTMLElement>('.blur-3xl');
    const emptyState = screen.getByText('Nothing scheduled yet').parentElement;
    const emptyIcon = emptyState?.querySelector<HTMLElement>('[class*="shadow-soft"]');

    expect(route?.className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');
    expect(route?.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(header?.className).toContain('bg-gradient-to-r');
    expect(header?.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(ambient?.className).toContain('[html[data-theme=monochrome]_&]:hidden');
    expect(emptyIcon?.className).toContain('shadow-soft');
    expect(emptyIcon?.className).toContain('[html[data-theme=monochrome]_&]:!transform-none');
    expect(emptyIcon?.className).toContain('motion-reduce:!transform-none');
  });

  it('removes populated-timeline blur and renders motion in its final reduced state', () => {
    scheduleState.reducedMotion = true;
    scheduleState.timelineEvents = [scheduledEvent('Design review')];

    render(<SchedulePage />);

    const eventTitle = screen.getByText('Design review');
    const eventRow = eventTitle.closest<HTMLElement>('li');
    const dayHeader = eventRow?.closest('section')?.firstElementChild as HTMLElement | null;
    const route = eventTitle.closest<HTMLElement>('[data-monochrome-route="schedule"]');
    const ambient = route?.querySelector<HTMLElement>('.blur-3xl');

    expect(dayHeader?.className).toContain('backdrop-blur-sm');
    expect(dayHeader?.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
    expect(eventRow?.className).toContain('[html[data-theme=monochrome]_&]:!transform-none');
    expect(eventRow?.className).toContain('[html[data-theme=monochrome]_&]:!opacity-100');
    expect(eventRow?.style.opacity).toBe('');
    expect(eventRow?.style.transform).toBe('');
    expect(ambient?.style.opacity).toBe('');
    expect(ambient?.style.transform).toBe('');
  });

  it('shows a recently expired event as Ended while a future event keeps its active state', () => {
    const past = scheduledEvent('Finished planning');
    const now = Date.now();
    past.event.start_at = now - 90 * 60_000;
    past.event.end_at = now - 30 * 60_000;
    past.instanceStartMs = past.event.start_at;
    past.instanceEndMs = past.event.end_at;
    const completed = scheduledEvent('Completed planning');
    completed.event.status = 'done';
    scheduleState.endedEvents = [past];
    scheduleState.timelineEvents = [scheduledEvent('Upcoming planning'), completed];

    render(<SchedulePage />);

    const endedRow = screen.getByText('Finished planning').closest('li');
    const activeRow = screen.getByText('Upcoming planning').closest('li');
    const completedRow = screen.getByText('Completed planning').closest('li');
    expect(endedRow?.textContent).toContain('Ended');
    expect(endedRow?.getAttribute('data-sakura-state')).toBe('complete');
    expect(activeRow?.textContent).not.toContain('Ended');
    expect(activeRow?.getAttribute('data-sakura-state')).toBe('scheduled');
    expect(completedRow?.textContent).toContain('Ended');
    expect(completedRow?.getAttribute('data-sakura-state')).toBe('complete');
  });

  it('keeps the Jarvis empty state still for MonoChrome and reduced-motion users', () => {
    scheduleState.reducedMotion = true;
    render(<SchedulePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Jarvis Actions' }));
    const emptyState = screen.getByText('No Jarvis Actions yet').parentElement;
    const emptyIcon = emptyState?.querySelector<HTMLElement>('[class*="shadow-soft"]');

    expect(emptyIcon?.className).toContain('[html[data-theme=monochrome]_&]:!transform-none');
    expect(emptyIcon?.className).toContain('motion-reduce:!transform-none');
  });

  it('uses immediate calendar navigation when reduced motion is requested', () => {
    scheduleState.reducedMotion = true;
    scheduleState.timelineEvents = [scheduledEvent('Calendar navigation')];
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    render(<SchedulePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    fireEvent.click(screen.getByTitle('1 item'));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('links visible event labels to the usable all-day switch and notes field', () => {
    render(<SchedulePage />);

    const allDay = screen.getByRole('switch', { name: 'All day' });
    const allDayLabelId = allDay.getAttribute('aria-labelledby');
    expect(allDayLabelId).not.toBeNull();
    expect(document.getElementById(allDayLabelId!)?.textContent?.trim()).toBe('All day');

    const notes = screen.getByRole('textbox', { name: 'Notes' });
    const notesLabelId = notes.getAttribute('aria-labelledby');
    expect(notesLabelId).not.toBeNull();
    expect(document.getElementById(notesLabelId!)?.textContent?.trim()).toBe('Notes');

    fireEvent.click(allDay);
    expect(allDay.getAttribute('aria-checked')).toBe('true');
    fireEvent.change(notes, { target: { value: 'Bring the accessibility notes.' } });
    expect((notes as HTMLTextAreaElement).value).toBe('Bring the accessibility notes.');
  });
});
