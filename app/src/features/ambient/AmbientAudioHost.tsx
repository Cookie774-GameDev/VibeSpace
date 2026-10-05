import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { effectivePlan } from '@/lib/entitlements';
import { useAppAdmin } from '@/lib/admin';
import { AmbientAudioEngine } from './ambientAudio';
import { shouldAmbientMusicPlay } from './ambientPlayback';
import { getPlayableAmbientTrack } from './tracks';
import { useMusicProjectStore } from './music-studio/musicProject';

export function AmbientAudioHost() {
  const [deskMusic, setDeskMusic] = React.useState(false);
  React.useEffect(() => {
    const players = new Set<string>();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; playing: boolean }>).detail;
      if (!detail?.id) return;
      if (detail.playing) players.add(detail.id);
      else players.delete(detail.id);
      setDeskMusic(players.size > 0);
    };
    window.addEventListener('vibespace:cao-desk-music', changed);
    return () => window.removeEventListener('vibespace:cao-desk-music', changed);
  }, []);
  const ambient = useUIStore((s) => s.ambient);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const ambientDrone = useUIStore((s) => s.ambientDrone);
  const ambientAlwaysPlay = useUIStore((s) => s.ambientAlwaysPlay);
  const ambientTrack = useUIStore((s) => s.ambientTrack);
  const ambientVolume = useUIStore((s) => s.ambientVolume);
  const plan = useAuthStore((s) => s.plan);
  const shouldPlay =
    !deskMusic && shouldAmbientMusicPlay(ambient, ambientActive, ambientDrone, ambientAlwaysPlay);
  const admin = useAppAdmin();
  const musicClips = useMusicProjectStore((state) => state.clips);
  const musicLoop = useMusicProjectStore((state) => state.loop);
  const musicProjectEnabled = useMusicProjectStore((state) => state.enabledForAmbient);
  const playableTrack = getPlayableAmbientTrack(ambientTrack, effectivePlan(plan, admin), admin);

  // Synchronize playing state
  React.useEffect(() => {
    const engine = AmbientAudioEngine.getInstance();

    if (shouldPlay) {
      const volume = useUIStore.getState().ambientVolume;
      if (musicProjectEnabled && musicClips.length > 0) {
        engine.playProject(musicClips, musicLoop, volume);
      } else {
        engine.play(playableTrack, volume);
      }
    } else {
      engine.stop();
    }
  }, [shouldPlay, playableTrack, musicClips, musicLoop, musicProjectEnabled]);

  React.useEffect(() => {
    AmbientAudioEngine.getInstance().setVolume(ambientVolume);
  }, [ambientVolume]);

  React.useEffect(() => {
    if (!shouldPlay) return;
    const unlock = () => {
      const engine = AmbientAudioEngine.getInstance();
      if (engine.getLoadStatus().state !== 'error') return;
      const volume = useUIStore.getState().ambientVolume;
      if (musicProjectEnabled && musicClips.length > 0) {
        engine.playProject(musicClips, musicLoop, volume);
      } else {
        engine.play(playableTrack, volume);
      }
    };

    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [shouldPlay, playableTrack, musicClips, musicLoop, musicProjectEnabled]);

  // Clean up on component unmount
  React.useEffect(() => {
    return () => {
      AmbientAudioEngine.getInstance().stop();
    };
  }, []);

  return null; // Host component is headless, no DOM rendering
}
