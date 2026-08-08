export function createAmbientScore() {
  let context = null;
  let master = null;
  let low = null;
  let high = null;
  let enabled = false;

  const build = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || context) return;
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);

    const makeVoice = (type, frequency, gainValue) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.value = gainValue;
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start();
      return { oscillator, gain };
    };

    low = makeVoice("sine", 82.41, 0.2);
    high = makeVoice("triangle", 164.81, 0.035);
  };

  const setEnabled = async (next) => {
    build();
    if (!context) return false;
    enabled = next;
    if (enabled) {
      await context.resume();
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.linearRampToValueAtTime(0.1, context.currentTime + 0.7);
    } else {
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.linearRampToValueAtTime(0, context.currentTime + 0.35);
      window.setTimeout(() => context?.suspend(), 420);
    }
    return enabled;
  };

  return {
    async unlock() {
      return setEnabled(true);
    },
    async toggle() {
      return setEnabled(!enabled);
    },
    setProgress(progress) {
      if (!context || !low || !high) return;
      const now = context.currentTime;
      low.oscillator.frequency.setTargetAtTime(82.41 + progress * 27, now, 0.25);
      high.oscillator.frequency.setTargetAtTime(164.81 + progress * 55, now, 0.2);
      high.gain.gain.setTargetAtTime(0.025 + progress * 0.025, now, 0.3);
    },
    isEnabled() {
      return enabled;
    },
    async destroy() {
      enabled = false;
      if (context && context.state !== "closed") await context.close();
      context = null;
    },
  };
}
