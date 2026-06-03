import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { AmbientAudioEngine } from './ambientAudio';

export function AmbientAudioHost() {
  const ambientDrone = useUIStore((s) => s.ambientDrone);
  const ambientActive = useUIStore((s) => s.ambientActive);
  const ambientAlwaysPlay = useUIStore((s) => s.ambientAlwaysPlay);
  const ambientTrack = useUIStore((s) => s.ambientTrack);
  const ambientVolume = useUIStore((s) => s.ambientVolume);
  const shouldPlay = ambientDrone && (ambientAlwaysPlay || ambientActive);

  // Synchronize playing state
  React.useEffect(() => {
    const engine = AmbientAudioEngine.getInstance();

    if (shouldPlay) {
      engine.play(ambientTrack, ambientVolume);
    } else {
      engine.stop();
    }
  }, [shouldPlay, ambientTrack, ambientVolume]);

  React.useEffect(() => {
    if (!shouldPlay) return;
    const unlock = () => {
      const engine = AmbientAudioEngine.getInstance();
      engine.play(ambientTrack, ambientVolume);
      void engine.resume();
    };

    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [shouldPlay, ambientTrack, ambientVolume]);

  // Clean up on component unmount
  React.useEffect(() => {
    return () => {
      AmbientAudioEngine.getInstance().stop();
    };
  }, []);

  return null; // Host component is headless, no DOM rendering
}
