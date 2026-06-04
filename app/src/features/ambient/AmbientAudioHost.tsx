import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { effectivePlan, isAdminIdentity } from '@/lib/entitlements';
import { AmbientAudioEngine } from './ambientAudio';
import { getPlayableAmbientTrack } from './tracks';

export function AmbientAudioHost() {
  const ambientDrone = useUIStore((s) => s.ambientDrone);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const ambientAlwaysPlay = useUIStore((s) => s.ambientAlwaysPlay);
  const ambientTrack = useUIStore((s) => s.ambientTrack);
  const ambientVolume = useUIStore((s) => s.ambientVolume);
  const plan = useAuthStore((s) => s.plan);
  const email = useAuthStore((s) => s.email);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email ?? null);
  const localUserId = useAuthStore((s) => s.localUserId);
  const shouldPlay = ambientDrone && (ambientAlwaysPlay || ambientActive);
  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const playableTrack = getPlayableAmbientTrack(ambientTrack, effectivePlan(plan, admin), admin);

  // Synchronize playing state
  React.useEffect(() => {
    const engine = AmbientAudioEngine.getInstance();

    if (shouldPlay) {
      engine.play(playableTrack, ambientVolume);
    } else {
      engine.stop();
    }
  }, [shouldPlay, playableTrack, ambientVolume]);

  React.useEffect(() => {
    if (!shouldPlay) return;
    const unlock = () => {
      const engine = AmbientAudioEngine.getInstance();
      engine.play(playableTrack, ambientVolume);
      void engine.resume();
    };

    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [shouldPlay, playableTrack, ambientVolume]);

  // Clean up on component unmount
  React.useEffect(() => {
    return () => {
      AmbientAudioEngine.getInstance().stop();
    };
  }, []);

  return null; // Host component is headless, no DOM rendering
}
