import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaoMission, CaoMissionWorker } from './mission/types';

const mocks = vi.hoisted(() => ({
  names: {} as Record<string, string>,
  ambientActive: false,
  displayName: 'Ada Lovelace',
}));
let reducedMotionMatches = false;
let notifyReducedMotionChange: (() => void) | undefined;

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => mocks.names }));
vi.mock('@/lib/db', () => ({
  db: {
    chats: { get: vi.fn(async () => undefined) },
    terminal_sessions: { get: vi.fn(async () => undefined) },
  },
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: { ambientActive: boolean }) => unknown) =>
    selector({ ambientActive: mocks.ambientActive }),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: { displayName: string }) => unknown) =>
    selector({ displayName: mocks.displayName }),
}));

import { CaoDeskScene } from './CaoDeskScene';

function makeWorker(index: number): CaoMissionWorker {
  return {
    targetId: `${index % 2 === 0 ? 'chat' : 'terminal'}-${index + 1}`,
    kind: index % 2 === 0 ? 'chat' : 'terminal',
    backend: index % 2 === 0 ? 'codex' : 'opencode',
    modelId: index % 2 === 0 ? 'openai/gpt-5.6-luna' : 'openai/gpt-6-luna',
    reasoningEffort: 'low',
    assignment: `Inspect live task ${index + 1}`,
    ownedPaths: [],
    status: 'running',
    lastObservedRevision: 1,
  };
}

function makeMission(count = 1): CaoMission {
  return {
    id: 'mission-live-1',
    schemaVersion: 1,
    accountId: 'account-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    objective: 'Verify the current mission desk.',
    createdAt: 1,
    updatedAt: 2,
    status: 'running',
    contextMapId: null,
    workers: Array.from({ length: count }, (_, index) => makeWorker(index)),
    milestones: [],
    latestPlanRevision: 1,
    lastCaoWakeAt: null,
  };
}

function sendDeskSelection(frame: HTMLIFrameElement, slot: number) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: { type: 'cao-desk-selected', slot },
    }),
  );
}

beforeEach(() => {
  mocks.names = {
    'chat-1': 'Mission planning chat',
    'terminal-2': 'OpenCode worker terminal',
    'chat-3': 'Verification chat',
    'terminal-4': 'Build terminal',
    'chat-5': 'Review chat',
    'terminal-6': 'Test terminal',
    'chat-7': 'Second room chat',
  };
  mocks.ambientActive = false;
  reducedMotionMatches = false;
  notifyReducedMotionChange = undefined;
  window.localStorage.clear();
  const preference = {
    get matches() {
      return reducedMotionMatches;
    },
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      notifyReducedMotionChange = () =>
        typeof listener === 'function'
          ? listener(new Event('change'))
          : listener.handleEvent(new Event('change'));
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => preference),
  );
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CAO desk scene', () => {
  it('keeps music off until enabled and restores the user volume preference', async () => {
    const first = render(<CaoDeskScene mission={makeMission()} />);
    const firstAudio = first.container.querySelector('audio')!;
    const play = vi.mocked(HTMLMediaElement.prototype.play);

    expect(play).not.toHaveBeenCalled();
    expect(firstAudio.volume).toBeCloseTo(0.35);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play desk music' }));
    });
    expect(play).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.localStorage.getItem('cao-desk-music')).toBe('on'));

    fireEvent.change(screen.getByRole('slider', { name: 'Desk music volume' }), {
      target: { value: '62' },
    });
    expect(firstAudio.volume).toBeCloseTo(0.62);
    expect(window.localStorage.getItem('cao-desk-volume')).toBe('62');

    first.unmount();
    const second = render(<CaoDeskScene mission={makeMission()} />);
    expect(second.container.querySelector('audio')!.volume).toBeCloseTo(0.62);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('lets the user pause the audio and persists the muted preference', async () => {
    const { container } = render(<CaoDeskScene mission={makeMission()} />);
    const audio = container.querySelector('audio')!;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play desk music' }));
    });
    fireEvent.play(audio);
    fireEvent.click(screen.getByRole('button', { name: 'Pause desk music' }));

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(window.localStorage.getItem('cao-desk-music')).toBe('off');
  });

  it('shows actual worker identity on selection and keeps unused desks empty across rooms', async () => {
    const mission = makeMission(7);
    const { container } = render(<CaoDeskScene mission={mission} />);
    const frame = screen.getByTitle('CAO team desk') as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);

    const [message] = postMessage.mock.calls.at(-1)!;
    expect(message).toMatchObject({
      type: 'cao-mission',
      mission: { id: 'mission-live-1:room:0' },
    });
    const sceneMessage = message as { mission: { workers: Array<Record<string, unknown>> } };
    expect(sceneMessage.mission.workers).toHaveLength(6);
    expect(sceneMessage.mission.workers[0]).toMatchObject({
      targetId: 'chat-1',
      assignment: 'Inspect live task 1',
      title: 'Mission planning chat',
    });
    expect(sceneMessage.mission.workers[1]).toMatchObject({
      targetId: 'terminal-2',
      title: 'OpenCode worker terminal',
    });
    expect(sceneMessage.mission.workers[2]).toMatchObject({
      targetId: 'chat-3',
      title: 'Verification chat',
    });

    act(() => sendDeskSelection(frame, 1));
    const details = screen.getByLabelText('Selected desk details');
    expect(details.querySelector('strong')?.textContent).toBe('OpenCode worker terminal');
    expect(screen.getByText('Terminal · running')).toBeTruthy();
    expect(screen.getByText('User: Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('CLI: OpenCode')).toBeTruthy();
    expect(screen.getByText('Model: openai/gpt-6-luna · low')).toBeTruthy();
    expect(screen.getByText('Task: Inspect live task 2')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'CAO room' }), {
      target: { value: '1' },
    });
    expect(screen.getByRole('button', { name: 'Second room chat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Empty desk 2' }));
    expect(screen.getByText('Empty desk', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('No chat or terminal is assigned to this desk.')).toBeTruthy();
    expect(container.querySelectorAll('.cao-desk-slots button')).toHaveLength(6);
  });

  it('keeps music, volume, and an exit action available in the immersive idle scene', async () => {
    const onExit = vi.fn();
    const { container } = render(
      <CaoDeskScene mission={makeMission()} immersive onExit={onExit} />,
    );
    const controls = screen.getByRole('group', { name: 'CAO desk controls' });
    const audio = container.querySelector('audio')!;

    expect(controls.querySelector('input[type="range"]')).not.toBeNull();
    expect(controls.querySelector('button[aria-label="Back to app"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(controls.querySelector('button[aria-label="Play desk music"]')!);
    });
    expect(window.localStorage.getItem('cao-desk-music')).toBe('on');
    fireEvent.change(controls.querySelector('input[type="range"]')!, {
      target: { value: '54' },
    });
    expect(audio.volume).toBeCloseTo(0.54);

    fireEvent.click(controls.querySelector('button[aria-label="Back to app"]')!);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('updates the 3D scene when the system reduced-motion preference changes', () => {
    render(<CaoDeskScene mission={makeMission()} />);
    const frame = screen.getByTitle('CAO team desk') as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);

    expect((postMessage.mock.calls.at(-1)?.[0] as { reducedMotion: boolean }).reducedMotion).toBe(
      false,
    );
    reducedMotionMatches = true;
    act(() => notifyReducedMotionChange?.());
    expect((postMessage.mock.calls.at(-1)?.[0] as { reducedMotion: boolean }).reducedMotion).toBe(
      true,
    );
  });
});
