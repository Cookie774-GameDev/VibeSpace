import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMusicMix, useMusicProjectStore } from './musicProject';

const audio = vi.hoisted(() => ({
  playProject: vi.fn(),
  progressListener: null as
    ((progress: { clipId: string | null; currentTime: number; duration: number }) => void) | null,
  statusListener: null as
    ((status: { state: 'idle' } | { state: 'error'; url: string; message: string }) => void) | null,
  resume: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
  subscribeProgress: vi.fn(
    (
      listener: (progress: {
        clipId: string | null;
        currentTime: number;
        duration: number;
      }) => void,
    ) => {
      audio.progressListener = listener;
      listener({ clipId: null, currentTime: 0, duration: 0 });
      return () => {
        audio.progressListener = null;
      };
    },
  ),
  subscribeStatus: vi.fn(
    (
      listener: (
        status: { state: 'idle' } | { state: 'error'; url: string; message: string },
      ) => void,
    ) => {
      audio.statusListener = listener;
      listener({ state: 'idle' });
      return () => {
        audio.statusListener = null;
      };
    },
  ),
}));
vi.mock('../ambientAudio', () => ({
  AmbientAudioEngine: { getInstance: () => audio },
}));
import { MusicStudio } from './MusicStudio';

describe('MusicStudio', () => {
  beforeEach(() => {
    audio.playProject.mockReset();
    audio.stop.mockReset();
    audio.seek.mockReset();
    useMusicProjectStore.setState({
      clips: [],
      loop: true,
      enabledForAmbient: false,
      savedAt: null,
    });
  });
  afterEach(cleanup);

  it('does not let a 15-second clip preview timer stop the full mix', () => {
    vi.useFakeTimers();
    try {
      useMusicProjectStore.setState({ clips: createDefaultMusicMix().slice(0, 2) });
      render(<MusicStudio open onOpenChange={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Edit Ain't No Time Like Now/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Play mix' }));
      expect(audio.playProject).toHaveBeenLastCalledWith(
        useMusicProjectStore.getState().clips,
        true,
        expect.any(Number),
      );
      act(() => vi.advanceTimersByTime(15_000));
      expect(audio.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a playback failure and returns the transport to Play mix', () => {
    useMusicProjectStore.setState({ clips: createDefaultMusicMix().slice(0, 1) });
    render(<MusicStudio open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play mix' }));
    act(() => {
      audio.statusListener?.({ state: 'error', url: 'track.mp3', message: 'File missing' });
    });
    expect(screen.getByRole('alert').textContent).toContain('File missing');
    expect(screen.getByRole('button', { name: 'Play mix' })).toBeTruthy();
  });

  it('searches, previews, adds, edits, reorders, and saves a cloud track', () => {
    render(<MusicStudio open onOpenChange={vi.fn()} />);
    expect(screen.getByText('63 unique cloud songs')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search cloud music'), {
      target: { value: "Ain't No Time" },
    });
    const preview = screen.getByRole('button', { name: /Preview Ain't No Time Like Now/ });
    fireEvent.click(preview);
    expect(audio.playProject).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Add Ain't No Time Like Now.*to mix/ }));
    expect(screen.getByText('1 clip in one continuous track')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Selected clip start (seconds)'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Selected clip speed'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useMusicProjectStore.getState().clips[0]).toMatchObject({
      trimStart: 5,
      speed: 1.5,
    });
    expect(useMusicProjectStore.getState().savedAt).toEqual(expect.any(Number));
  }, 20_000);

  it('renders the complete prebuilt mix as a clickable horizontal timeline and edits one selected clip', () => {
    useMusicProjectStore.setState({ clips: createDefaultMusicMix(), savedAt: null });
    render(<MusicStudio open onOpenChange={vi.fn()} />);

    expect(screen.getByText('63 clips in one continuous track')).toBeTruthy();
    const first = screen.getByRole('button', { name: /Edit Ain't No Time Like Now/ });
    fireEvent.click(first);
    expect(audio.playProject).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: "Ain't No Time Like Now - BLAEKER" })).toBeTruthy();
    expect(screen.getByLabelText('Selected clip start (seconds)')).toBeTruthy();
    const timeline = screen.getAllByTestId('music-timeline-clip');
    expect(timeline).toHaveLength(63);
    expect(screen.getByText('A1')).toBeTruthy();
    expect(screen.getAllByTestId('music-clip-waveform')).toHaveLength(63);
    const zoom = screen.getByLabelText('Music timeline zoom');
    expect(zoom.getAttribute('value')).toBe('1');
    fireEvent.change(zoom, { target: { value: '1.5' } });
    expect(timeline[0]!.getAttribute('data-zoom')).toBe('1.5');
    expect(within(timeline[0]!).getByText('Selected')).toBeTruthy();
    expect(first.getAttribute('aria-pressed')).toBe('true');

    const originalIds = useMusicProjectStore.getState().clips.map((clip) => clip.id);
    fireEvent.dragStart(timeline[0]!);
    fireEvent.dragOver(timeline[2]!);
    fireEvent.drop(timeline[2]!);
    expect(
      useMusicProjectStore
        .getState()
        .clips.slice(0, 3)
        .map((clip) => clip.id),
    ).toEqual([originalIds[1], originalIds[2], originalIds[0]]);
  }, 20_000);

  it('shows a bounded playhead on the active mix clip', () => {
    useMusicProjectStore.setState({ clips: createDefaultMusicMix().slice(0, 2), savedAt: null });
    render(<MusicStudio open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Play mix' }));
    const first = useMusicProjectStore.getState().clips[0]!;
    act(() => {
      audio.progressListener?.({ clipId: first.id, currentTime: 30, duration: 120 });
    });

    const playhead = screen.getByTestId('music-timeline-playhead');
    expect(playhead.getAttribute('style')).toContain('left: 25%');
    expect(playhead.getAttribute('aria-label')).toContain(first.name);
  });

  it('shows a seekable start-to-finish timeline only for a selected-song preview', () => {
    useMusicProjectStore.setState({ clips: createDefaultMusicMix().slice(0, 1), savedAt: null });
    render(<MusicStudio open onOpenChange={vi.fn()} />);

    const first = useMusicProjectStore.getState().clips[0]!;
    fireEvent.click(screen.getByRole('button', { name: `Edit ${first.name}` }));
    act(() => {
      audio.progressListener?.({ clipId: first.id, currentTime: 30, duration: 120 });
    });

    const timeline = screen.getByLabelText(`Preview position for ${first.name}`);
    expect(timeline.getAttribute('min')).toBe('0');
    expect(timeline.getAttribute('max')).toBe('120');
    expect(timeline.getAttribute('value')).toBe('30');
    fireEvent.change(timeline, { target: { value: '75' } });
    expect(audio.seek).toHaveBeenCalledWith(75);

    fireEvent.click(screen.getByRole('button', { name: 'Play mix' }));
    expect(screen.queryByLabelText(`Preview position for ${first.name}`)).toBeNull();
  });
});
