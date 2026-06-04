import type { ClockSound } from './clockStore';

export function playClockSound(sound: ClockSound = 'chime', volume = 0.9): void {
  if (typeof window === 'undefined') return;
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const ctx = new AudioContextCtor();
    const master = ctx.createGain();
    master.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), ctx.currentTime);
    master.connect(ctx.destination);

    const pattern =
      sound === 'pulse'
        ? [220, 330, 220]
        : sound === 'soft'
          ? [523.25, 659.25]
          : [659.25, 880, 1174.66];

    pattern.forEach((frequency, index) => {
      const start = ctx.currentTime + index * 0.18;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = sound === 'pulse' ? 'square' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(sound === 'soft' ? 0.18 : 0.32, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    });

    window.setTimeout(() => void ctx.close().catch(() => undefined), 1200);
  } catch {
    return;
  }
}
