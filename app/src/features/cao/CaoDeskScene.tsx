import { useEffect, useRef, useState, useId } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Maximize2, Minimize2, Music2, Pause, X } from 'lucide-react';
import { db } from '@/lib/db';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import type { CaoMission, CaoMissionWorker } from './mission/types';
import { DESKS_PER_ROOM, deskRoomCount, deskRoomIndex } from './deskRooms';
import './cao-controls.css';

const EMPTY_WORKERS: readonly CaoMissionWorker[] = [];
const DESK_MUSIC_ENABLED_KEY = 'cao-desk-music';
const DESK_MUSIC_VOLUME_KEY = 'cao-desk-volume';
const DEFAULT_DESK_MUSIC_VOLUME = 35;

function readDeskMusicEnabled() {
  try {
    return window.localStorage.getItem(DESK_MUSIC_ENABLED_KEY) === 'on';
  } catch {
    return false;
  }
}

function readDeskMusicVolume() {
  try {
    const stored = window.localStorage.getItem(DESK_MUSIC_VOLUME_KEY);
    if (stored === null) return DEFAULT_DESK_MUSIC_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : DEFAULT_DESK_MUSIC_VOLUME;
  } catch {
    return DEFAULT_DESK_MUSIC_VOLUME;
  }
}

function persistDeskMusicPreference(enabled: boolean) {
  try {
    window.localStorage.setItem(DESK_MUSIC_ENABLED_KEY, enabled ? 'on' : 'off');
  } catch {
    // Playback still works for this session when storage is unavailable.
  }
}

function persistDeskMusicVolume(volume: number) {
  try {
    window.localStorage.setItem(DESK_MUSIC_VOLUME_KEY, String(volume));
  } catch {
    // Playback still works for this session when storage is unavailable.
  }
}

export function CaoDeskScene({
  mission,
  workers: previewWorkers,
  immersive = false,
  onExit,
}: {
  mission?: CaoMission;
  workers?: readonly CaoMissionWorker[];
  immersive?: boolean;
  onExit?: () => void;
}) {
  const musicId = useId();
  const reportMusic = (playing: boolean) =>
    window.dispatchEvent(
      new CustomEvent('vibespace:cao-desk-music', { detail: { id: musicId, playing } }),
    );
  const workers = mission?.workers ?? previewWorkers ?? EMPTY_WORKERS;
  const figure = useRef<HTMLElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    audio = useRef<HTMLAudioElement>(null);
  const [ready, setReady] = useState(false),
    [room, setRoom] = useState(0);
  const [selected, setSelected] = useState<number | null>(null),
    [fullscreen, setFullscreen] = useState(false);
  const [playing, setPlaying] = useState(false),
    [musicError, setMusicError] = useState('');
  const [musicEnabled, setMusicEnabled] = useState(readDeskMusicEnabled);
  const [musicVolume, setMusicVolume] = useState(readDeskMusicVolume);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const musicEnabledRef = useRef(musicEnabled);
  musicEnabledRef.current = musicEnabled;
  const ambientActive = useUIStore((state) => state.ambientActive);
  const userName = useAuthStore((state) => state.displayName) || 'Local user';
  const roomCount = deskRoomCount(workers.length),
    currentRoom = Math.min(room, roomCount - 1);
  const names = useLiveQuery(async () => {
    const entries = await Promise.all(
      workers.map(async (worker) => {
        const row =
          worker.kind === 'chat'
            ? await db.chats.get(worker.targetId as never)
            : await db.terminal_sessions.get(worker.targetId as never);
        return [
          worker.targetId,
          row &&
          (!mission ||
            (String(row.workspace_id) === mission.workspaceId &&
              String(row.project_id ?? '') === (mission.projectId ?? '')))
            ? row.title
            : worker.targetId,
        ] as const;
      }),
    );
    return Object.fromEntries(entries);
  }, [mission?.id, workers]);
  const send = () =>
    frame.current?.contentWindow?.postMessage(
      {
        type: 'cao-mission',
        mission: {
          id: `${mission?.id ?? 'preview'}:room:${currentRoom}`,
          status: mission?.status ?? 'preview',
          workers: workers
            .slice(currentRoom * DESKS_PER_ROOM, (currentRoom + 1) * DESKS_PER_ROOM)
            .map(({ targetId, assignment, status }) => ({
              targetId,
              assignment,
              status,
              title: names?.[targetId] ?? targetId,
            })),
        },
        reducedMotion,
        immersive: immersive || fullscreen,
      },
      window.location.origin,
    );
  useEffect(() => {
    if (ready) send();
  }, [ready, mission, workers, currentRoom, names, immersive, fullscreen, reducedMotion]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    if (typeof preference.addEventListener === 'function') {
      preference.addEventListener('change', update);
      return () => preference.removeEventListener('change', update);
    }
    preference.addListener(update);
    return () => preference.removeListener(update);
  }, []);
  useEffect(() => {
    const changeRoom = (key: string) => {
      if (key !== 'PageUp' && key !== 'PageDown') return;
      setRoom((value) => Math.max(0, Math.min(roomCount - 1, value + (key === 'PageDown' ? 1 : -1))));
      setSelected(null);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      if (
        event.data?.type === 'cao-desk-selected' &&
        Number.isInteger(event.data.slot) &&
        event.data.slot >= 0 &&
        event.data.slot < 6
      )
        setSelected(currentRoom * 6 + event.data.slot);
      if (event.data?.type === 'cao-scene-escape' && !document.fullscreenElement) onExit?.();
      if (event.data?.type === 'cao-scene-room') changeRoom(event.data.key);
    };
    window.addEventListener('message', receive);
    const changed = () => setFullscreen(document.fullscreenElement === figure.current);
    document.addEventListener('fullscreenchange', changed);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) onExit?.();
      if (immersive || document.fullscreenElement === figure.current) changeRoom(event.key);
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('message', receive);
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', escape);
    };
  }, [currentRoom, roomCount, immersive, onExit]);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    element.volume = musicVolume / 100;
  }, [musicVolume]);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (musicEnabledRef.current && (!ambientActive || immersive))
      void element.play().catch(() => setPlaying(false));
    else element.pause();
    return () => {
      element.pause();
      reportMusic(false);
    };
  }, [ambientActive, immersive]);
  const toggleMusic = async () => {
    if (!audio.current) return;
    setMusicError('');
    if (playing) {
      audio.current.pause();
      persistDeskMusicPreference(false);
      setMusicEnabled(false);
    } else {
      if (ambientActive && !immersive) {
        persistDeskMusicPreference(true);
        setMusicEnabled(true);
        return;
      }
      try {
        await audio.current.play();
        persistDeskMusicPreference(true);
        setMusicEnabled(true);
      } catch {
        setMusicError('Music could not start. Try Play music again.');
      }
    }
  };
  const changeMusicVolume = (value: number) => {
    const volume = Math.min(100, Math.max(0, value));
    setMusicVolume(volume);
    persistDeskMusicVolume(volume);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await figure.current?.requestFullscreen();
    } catch {
      setMusicError('Fullscreen is unavailable in this window.');
    }
  };
  const worker = selected === null ? undefined : workers[selected];
  return (
    <figure
      ref={figure}
      className={`cao-desk-view ${immersive ? 'cao-desk-immersive' : ''}`}
      aria-label="CAO team workspace"
    >
      <div className="cao-desk-toolbar">
        <span className="font-medium">Jarvis CAO</span>
        <label>
          Room{' '}
          <select
            aria-label="CAO room"
            value={currentRoom}
            onChange={(e) => {
              setRoom(Number(e.target.value));
              setSelected(null);
              setReady(false);
            }}
          >
            {Array.from({ length: roomCount }, (_, i) => (
              <option key={i} value={i}>
                {i + 1} of {roomCount}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void toggleMusic()}
          aria-label={playing ? 'Pause desk music' : 'Play desk music'}
        >
          {playing ? <Pause size={15} /> : <Music2 size={15} />}{' '}
          {playing ? 'Pause music' : 'Play music'}
        </button>
        <input
          aria-label="Desk music volume"
          type="range"
          min="0"
          max="100"
          value={musicVolume}
          onChange={(e) => {
            changeMusicVolume(Number(e.target.value));
          }}
        />
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? 'Exit desk fullscreen' : 'View desk fullscreen'}
        >
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        {onExit && (
          <button type="button" onClick={onExit} aria-label="Back to app">
            <X size={16} />
          </button>
        )}
      </div>
      <div className="cao-desk-stage">
        <iframe
          key={currentRoom}
          ref={frame}
          title="CAO team desk"
          src="/cao-desk/index.html"
          allow="fullscreen; autoplay"
          sandbox="allow-scripts allow-same-origin"
          onLoad={() => {
            setReady(true);
            send();
          }}
        />
        {(immersive || fullscreen) && (
          <div
            className="fixed bottom-4 right-4 z-[220] flex items-center gap-2 rounded-xl border border-border bg-background/90 p-2 text-foreground shadow-xl"
            aria-label="CAO desk controls"
            role="group"
          >
            <button
              type="button"
              onClick={() => void toggleMusic()}
              aria-label={playing ? 'Pause desk music' : 'Play desk music'}
            >
              {playing ? <Pause size={15} /> : <Music2 size={15} />}
              {playing ? 'Pause music' : 'Play music'}
            </button>
            <input
              aria-label="Desk music volume"
              type="range"
              min="0"
              max="100"
              value={musicVolume}
              onChange={(event) => changeMusicVolume(Number(event.target.value))}
            />
            {fullscreen && (
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                aria-label="Exit desk fullscreen"
              >
                <Minimize2 size={16} />
              </button>
            )}
            {onExit && (
              <button type="button" onClick={onExit} aria-label="Back to app">
                <X size={16} />
              </button>
            )}
          </div>
        )}
        {selected !== null && (
          <aside className="cao-desk-info" aria-label="Selected desk details">
            <button type="button" aria-label="Close desk details" onClick={() => setSelected(null)}>
              <X size={14} />
            </button>
            <strong>{worker ? (names?.[worker.targetId] ?? worker.targetId) : 'Empty desk'}</strong>
            {worker ? (
              <>
                <p>
                  {worker.kind === 'chat' ? 'Chat' : 'Terminal'} · {worker.status}
                </p>
                <p>User: {userName}</p>
                <p>CLI: {worker.backend === 'codex' ? 'Codex' : worker.backend === 'opencode' ? 'OpenCode' : 'Not recorded'}</p>
                <p className="break-all">{worker.targetId}</p>
                <p>
                  Model: {worker.modelId || 'Not recorded'} · {worker.reasoningEffort || 'Default effort'}
                </p>
                <p>Task: {worker.assignment}</p>
              </>
            ) : (
              <p>No chat or terminal is assigned to this desk.</p>
            )}
            {roomCount > 1 && (
              <label className="mt-3 block">Room <select aria-label="Desk details room" value={currentRoom} onChange={(event) => { setRoom(Number(event.target.value)); setSelected(null); }}>
                {Array.from({ length: roomCount }, (_, index) => <option key={index} value={index}>{index + 1} of {roomCount}</option>)}
              </select></label>
            )}
          </aside>
        )}
      </div>
      <div className="cao-desk-slots" aria-label="Desks in this room">
        {Array.from({ length: 6 }, (_, slot) => {
          const index = deskRoomIndex(currentRoom, slot, workers.length),
            item = index === null ? undefined : workers[index];
          return (
            <button type="button" key={slot} onClick={() => setSelected(currentRoom * 6 + slot)}>
              {item
                ? (names?.[item.targetId] ?? `${item.kind} ${index! + 1}`)
                : `Empty desk ${slot + 1}`}
            </button>
          );
        })}
      </div>
      <figcaption>
        Drag to orbit · Shift-drag to pan · Scroll to zoom · Click a desk for details · PgUp/PgDn for rooms · Esc to exit fullscreen
        {musicError && <span role="status"> · {musicError}</span>}
      </figcaption>
      <audio
        ref={audio}
        src="/cao-desk/assets/original-audio.m4a"
        loop
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          reportMusic(true);
        }}
        onPause={() => {
          setPlaying(false);
          reportMusic(false);
        }}
        onError={() => setMusicError('Desk music is unavailable.')}
      />
    </figure>
  );
}
