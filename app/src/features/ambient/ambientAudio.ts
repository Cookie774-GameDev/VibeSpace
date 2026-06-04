import type { AmbientTrack } from '@/stores/ui';

export class AmbientAudioEngine {
  private static instance: AmbientAudioEngine | null = null;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Track specific nodes and sources to allow crossfades
  private activeTrackId: AmbientTrack | null = null;
  private activeTrackNodes: {
    gain: GainNode;
    sources: { stop: () => void }[];
  } | null = null;

  private currentVolumePercent = 40;
  private isEngineRunning = false;

  private constructor() {
    // Lazy initialization of AudioContext on first play/user gesture
  }

  public static getInstance(): AmbientAudioEngine {
    if (!AmbientAudioEngine.instance) {
      AmbientAudioEngine.instance = new AmbientAudioEngine();
    }
    return AmbientAudioEngine.instance;
  }

  private initContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioContextClass();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      
      // Master volume scale: audible at normal speaker levels without hitting full app volume.
      this.updateMasterVolume();
    }
    
    void this.resume();
    return this.ctx;
  }

  private updateMasterVolume(): void {
    if (!this.masterGain || !this.ctx) return;
    const targetGain = (this.currentVolumePercent / 100) * 0.55;
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(targetGain, this.ctx.currentTime + 0.1);
  }

  public play(track: AmbientTrack, volume: number): void {
    this.currentVolumePercent = volume;
    const ctx = this.initContext();
    this.updateMasterVolume();

    if (this.activeTrackId === track && this.isEngineRunning) {
      return;
    }

    this.isEngineRunning = true;

    // If a track is already playing, crossfade
    if (this.activeTrackNodes) {
      const oldNodes = this.activeTrackNodes;
      const now = ctx.currentTime;
      // Fade out old track over 2 seconds
      oldNodes.gain.gain.setValueAtTime(oldNodes.gain.gain.value, now);
      oldNodes.gain.gain.linearRampToValueAtTime(0, now + 2.0);
      
      setTimeout(() => {
        try {
          oldNodes.sources.forEach(src => src.stop());
        } catch (e) {
          // Ignore if already stopped
        }
      }, 2500);
    }

    // Start the new track
    this.activeTrackId = track;
    const trackGain = ctx.createGain();
    trackGain.gain.setValueAtTime(0, ctx.currentTime);
    trackGain.connect(this.masterGain!);

    // Fade in new track over 1.5 seconds
    trackGain.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 1.5);

    const sources: { stop: () => void }[] = [];

    // Synthesize the chosen track
    if (track === 'calm-focus') {
      this.buildCalmFocus(ctx, trackGain, sources);
    } else if (track === 'calm-piano') {
      this.buildCalmPiano(ctx, trackGain, sources);
    } else if (track === 'soothing-rain') {
      this.buildSoothingRain(ctx, trackGain, sources);
    } else if (track === 'soothing-space') {
      this.buildSoothingSpace(ctx, trackGain, sources);
    } else if (track === 'warm-hearth') {
      this.buildWarmHearth(ctx, trackGain, sources);
    } else if (track === 'deep-ocean') {
      this.buildDeepOcean(ctx, trackGain, sources);
    } else if (track === 'starlight') {
      this.buildStarlight(ctx, trackGain, sources);
    } else if (track === 'forest-rain') {
      this.buildForestRain(ctx, trackGain, sources);
    } else if (track === 'lofi-night') {
      this.buildLofiNight(ctx, trackGain, sources);
    } else if (track === 'lofi-rain') {
      this.buildLofiRain(ctx, trackGain, sources);
    } else if (track === 'rap-cipher') {
      this.buildRapCipher(ctx, trackGain, sources);
    } else if (track === 'rap-instrumental') {
      this.buildRapInstrumental(ctx, trackGain, sources);
    }

    this.activeTrackNodes = {
      gain: trackGain,
      sources
    };
  }

  public stop(): void {
    if (!this.isEngineRunning || !this.ctx || !this.activeTrackNodes) {
      return;
    }
    
    this.isEngineRunning = false;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const activeNodes = this.activeTrackNodes;
    this.activeTrackNodes = null;
    this.activeTrackId = null;

    // 1. Soft Swish sound effect: a brief noise burst filtered via a fast closing lowpass
    try {
      const bufferSize = ctx.sampleRate * 0.15; // 150ms buffer
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 1.0;
      filter.frequency.setValueAtTime(1200, now);
      filter.frequency.exponentialRampToValueAtTime(80, now + 0.12);

      const swishGain = ctx.createGain();
      swishGain.gain.setValueAtTime(0.015, now);
      swishGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

      noise.connect(filter);
      filter.connect(swishGain);
      swishGain.connect(ctx.destination);
      noise.start(now);
    } catch (e) {
      console.warn('Failed to synthesize ambient swish exit sound:', e);
    }

    // 2. Fade main audio to 0 over 1.5s
    activeNodes.gain.gain.setValueAtTime(activeNodes.gain.gain.value, now);
    activeNodes.gain.gain.linearRampToValueAtTime(0, now + 1.5);

    setTimeout(() => {
      try {
        activeNodes.sources.forEach(src => src.stop());
      } catch (e) {
        // Safe to ignore
      }
    }, 1800);
  }

  public setVolume(volume: number): void {
    this.currentVolumePercent = volume;
    this.updateMasterVolume();
  }

  public setTrack(track: AmbientTrack): void {
    if (this.isEngineRunning) {
      this.play(track, this.currentVolumePercent);
    } else {
      this.activeTrackId = track;
    }
  }

  public async resume(): Promise<void> {
    if (!this.ctx || this.ctx.state !== 'suspended') return;
    try {
      await this.ctx.resume();
    } catch (err) {
      console.warn('Ambient audio resume was blocked until the next user gesture:', err);
    }
  }

  public isPlaying(): boolean {
    return this.isEngineRunning;
  }

  public dispose(): void {
    this.stop();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
      this.masterGain = null;
    }
  }

  // --- Track synthesis builders ---

  private createNoiseSource(ctx: AudioContext, seconds = 2, brown = false): AudioBufferSourceNode {
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        output[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = output[i];
        output[i] *= 3.5;
      } else {
        output[i] = white;
      }
    }
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    return source;
  }

  private pulse(
    ctx: AudioContext,
    dest: AudioNode,
    frequency: number,
    when: number,
    duration: number,
    gainValue: number,
    type: OscillatorType = 'sine',
  ): void {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(gainValue, when + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(gain);
    gain.connect(dest);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
  }

  private buildCalmFocus(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const chordGain = ctx.createGain();
    chordGain.gain.setValueAtTime(0.16, ctx.currentTime);
    chordGain.connect(dest);

    [261.63, 329.63, 392.0, 523.25].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      osc.type = index === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(index === 0 ? 0.22 : 0.12, ctx.currentTime);
      osc.connect(gain);
      gain.connect(chordGain);
      osc.start();
      sources.push(osc);
    });

    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(0.045, ctx.currentTime);
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.setValueAtTime(0.055, ctx.currentTime);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(chordGain.gain);
    shimmer.start();
    sources.push(shimmer);
  }

  private buildSoothingRain(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const pad = ctx.createGain();
    pad.gain.setValueAtTime(0.12, ctx.currentTime);
    pad.connect(dest);
    [196, 246.94, 293.66].forEach((frequency) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);
      osc.connect(pad);
      osc.start();
      sources.push(osc);
    });

    const rain = this.createNoiseSource(ctx, 2, true);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1700, ctx.currentTime);
    filter.Q.setValueAtTime(0.6, ctx.currentTime);
    const rainGain = ctx.createGain();
    rainGain.gain.setValueAtTime(0.2, ctx.currentTime);
    rain.connect(filter);
    filter.connect(rainGain);
    rainGain.connect(dest);
    rain.start();
    sources.push(rain);
  }

  private buildCalmPiano(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    this.buildCalmFocus(ctx, dest, sources);
    const notes = [523.25, 659.25, 783.99, 987.77];
    let index = 0;
    const interval = window.setInterval(() => {
      if (!this.isEngineRunning) return;
      const when = ctx.currentTime + 0.025;
      this.pulse(ctx, dest, notes[index % notes.length]!, when, 0.45, 0.055, 'triangle');
      index += 1;
    }, 2400);
    sources.push({ stop: () => window.clearInterval(interval) });
  }

  private buildSoothingSpace(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    this.buildStarlight(ctx, dest, sources);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(73.42, ctx.currentTime);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.08, ctx.currentTime);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start();
    sources.push(sub);
  }

  private buildLofiNight(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    this.buildCalmFocus(ctx, dest, sources);

    const beatGain = ctx.createGain();
    beatGain.gain.setValueAtTime(0.35, ctx.currentTime);
    beatGain.connect(dest);
    const bpm = 78;
    const step = 60 / bpm / 2;
    let count = 0;
    const interval = window.setInterval(() => {
      if (!this.isEngineRunning) return;
      const when = ctx.currentTime + 0.02;
      const position = count % 8;
      if (position === 0 || position === 4) this.pulse(ctx, beatGain, 58, when, 0.18, 0.45, 'sine');
      if (position === 2 || position === 6) this.pulse(ctx, beatGain, 190, when, 0.08, 0.18, 'triangle');
      this.pulse(ctx, beatGain, 8200, when, 0.035, position % 2 === 0 ? 0.04 : 0.025, 'square');
      count += 1;
    }, step * 1000);

    sources.push({ stop: () => window.clearInterval(interval) });
  }

  private buildRapInstrumental(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(49, ctx.currentTime);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.16, ctx.currentTime);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start();
    sources.push(sub);

    const beatGain = ctx.createGain();
    beatGain.gain.setValueAtTime(0.42, ctx.currentTime);
    beatGain.connect(dest);
    const bpm = 92;
    const step = 60 / bpm / 4;
    let count = 0;
    const interval = window.setInterval(() => {
      if (!this.isEngineRunning) return;
      const when = ctx.currentTime + 0.015;
      const position = count % 16;
      if ([0, 6, 10].includes(position)) this.pulse(ctx, beatGain, 46, when, 0.2, 0.55, 'sine');
      if ([4, 12].includes(position)) this.pulse(ctx, beatGain, 210, when, 0.09, 0.2, 'triangle');
      if (position % 2 === 0 || position === 15) this.pulse(ctx, beatGain, 9500, when, 0.025, 0.055, 'square');
      count += 1;
    }, step * 1000);

    sources.push({ stop: () => window.clearInterval(interval) });
  }

  private buildLofiRain(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    this.buildLofiNight(ctx, dest, sources);
    const rain = this.createNoiseSource(ctx, 2, true);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, ctx.currentTime);
    filter.Q.setValueAtTime(0.5, ctx.currentTime);
    const rainGain = ctx.createGain();
    rainGain.gain.setValueAtTime(0.08, ctx.currentTime);
    rain.connect(filter);
    filter.connect(rainGain);
    rainGain.connect(dest);
    rain.start();
    sources.push(rain);
  }

  private buildRapCipher(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    this.buildRapInstrumental(ctx, dest, sources);
    const leadGain = ctx.createGain();
    leadGain.gain.setValueAtTime(0.18, ctx.currentTime);
    leadGain.connect(dest);
    const notes = [146.83, 174.61, 196, 220];
    let count = 0;
    const interval = window.setInterval(() => {
      if (!this.isEngineRunning) return;
      const when = ctx.currentTime + 0.02;
      if (count % 4 !== 3) this.pulse(ctx, leadGain, notes[count % notes.length]!, when, 0.12, 0.08, 'sawtooth');
      count += 1;
    }, 330);
    sources.push({ stop: () => window.clearInterval(interval) });
  }

  private buildWarmHearth(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 1. Two detuned low pads at 110Hz (A2) and 165Hz (E3)
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(110, ctx.currentTime);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(165.5, ctx.currentTime); // detuned

    const padGain = ctx.createGain();
    padGain.gain.setValueAtTime(0.3, ctx.currentTime);

    // Filter to keep it warm and mellow
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(350, ctx.currentTime);

    osc1.connect(padGain);
    osc2.connect(padGain);
    padGain.connect(filter);
    filter.connect(dest);

    osc1.start();
    osc2.start();
    sources.push(osc1, osc2);

    if (!prefersReducedMotion) {
      // Slow LFO on filter cutoff to create breathing fireplace heat
      const filterLfo = ctx.createOscillator();
      filterLfo.frequency.setValueAtTime(0.08, ctx.currentTime); // very slow (12s period)
      
      const filterLfoGain = ctx.createGain();
      filterLfoGain.gain.setValueAtTime(120, ctx.currentTime); // mod range

      filterLfo.connect(filterLfoGain);
      filterLfoGain.connect(filter.frequency);
      filterLfo.start();
      sources.push(filterLfo);
    }

    // 2. Fire Crackle: heavy filtered brownian noise with sporadic spikes
    const crackleGain = ctx.createGain();
    crackleGain.gain.setValueAtTime(0.04, ctx.currentTime);
    crackleGain.connect(dest);

    // Create brown noise buffer
    const bufferSize = ctx.sampleRate * 2.0; // 2 seconds loop
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5; // compensation
    }

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    // Highpass to isolate crackle click frequencies
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.setValueAtTime(1000, ctx.currentTime);

    // Random gains via script node or interval LFO to simulate crackle frequency
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'bandpass';
    crackleFilter.frequency.setValueAtTime(2500, ctx.currentTime);
    crackleFilter.Q.setValueAtTime(1.5, ctx.currentTime);

    noiseSource.connect(highpass);
    highpass.connect(crackleFilter);
    crackleFilter.connect(crackleGain);
    
    noiseSource.start();
    sources.push(noiseSource);

    // Trigger random crackle burst volumes using timer interval
    let crackleInterval = setInterval(() => {
      if (!this.isEngineRunning || !ctx) {
        clearInterval(crackleInterval);
        return;
      }
      const now = ctx.currentTime;
      // Sporadic volume spikes for crackles
      const volumeSpike = Math.random() > 0.6 ? (Math.random() * 0.15 + 0.02) : 0.02;
      crackleGain.gain.setValueAtTime(crackleGain.gain.value, now);
      crackleGain.gain.exponentialRampToValueAtTime(volumeSpike, now + 0.05);
    }, 280);

    // Store custom cleanup
    const originalStop = sources[0].stop;
    sources[0].stop = () => {
      clearInterval(crackleInterval);
      sources.forEach(s => {
        if (s !== osc1) {
          try { s.stop(); } catch(e) {}
        }
      });
      try { osc1.stop(); } catch(e) {}
    };
  }

  private buildDeepOcean(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 1. Deep Sub bass at ~55Hz (A1)
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(55, ctx.currentTime);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.65, ctx.currentTime);

    subOsc.connect(subGain);
    subGain.connect(dest);
    subOsc.start();
    sources.push(subOsc);

    if (!prefersReducedMotion) {
      // Very slow LFO on sub volume (simulate deep swells)
      const subLfo = ctx.createOscillator();
      subLfo.frequency.setValueAtTime(0.06, ctx.currentTime); // 16.6s period
      
      const subLfoGain = ctx.createGain();
      subLfoGain.gain.setValueAtTime(0.2, ctx.currentTime); // modulate up/down by 0.2

      const subBaseGain = ctx.createGain();
      subBaseGain.gain.setValueAtTime(0.45, ctx.currentTime);

      subLfo.connect(subLfoGain);
      subLfoGain.connect(subGain.gain);
      subLfo.start();
      sources.push(subLfo);
    }

    // 2. Low rolling water texture: white noise through a narrow shifting bandpass filter
    const bufferSize = ctx.sampleRate * 2.0;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const waterNoise = ctx.createBufferSource();
    waterNoise.buffer = noiseBuffer;
    waterNoise.loop = true;

    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(150, ctx.currentTime);
    bpf.Q.setValueAtTime(0.8, ctx.currentTime);

    const waterGain = ctx.createGain();
    waterGain.gain.setValueAtTime(0.18, ctx.currentTime);

    waterNoise.connect(bpf);
    bpf.connect(waterGain);
    waterGain.connect(dest);

    waterNoise.start();
    sources.push(waterNoise);

    if (!prefersReducedMotion) {
      // Swell filter LFO to simulate waves breaking
      const waveLfo = ctx.createOscillator();
      waveLfo.frequency.setValueAtTime(0.075, ctx.currentTime); // ~13.3s period
      
      const waveLfoGain = ctx.createGain();
      waveLfoGain.gain.setValueAtTime(80, ctx.currentTime); // modulate filter between 70Hz and 230Hz

      waveLfo.connect(waveLfoGain);
      waveLfoGain.connect(bpf.frequency);
      waveLfo.start();
      sources.push(waveLfo);
    }
  }

  private buildStarlight(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Ethereal chord (A Major: A4 at 440, C#5 at 554.37, E5 at 659.25)
    const frequencies = [440.0, 554.37, 659.25];
    const chordGain = ctx.createGain();
    chordGain.gain.setValueAtTime(0.15, ctx.currentTime);
    chordGain.connect(dest);

    frequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      const individualGain = ctx.createGain();
      individualGain.gain.setValueAtTime(0.3, ctx.currentTime);

      osc.connect(individualGain);
      individualGain.connect(chordGain);
      osc.start();
      sources.push(osc);

      if (!prefersReducedMotion) {
        // Ethereal slow volume LFO per frequency to weave them in and out
        const vLfo = ctx.createOscillator();
        vLfo.frequency.setValueAtTime(0.05 + idx * 0.02, ctx.currentTime); // unsynced speeds

        const vLfoGain = ctx.createGain();
        vLfoGain.gain.setValueAtTime(0.15, ctx.currentTime);

        vLfo.connect(vLfoGain);
        vLfoGain.connect(individualGain.gain);
        vLfo.start();
        sources.push(vLfo);

        // Pitch shimmer (frequency drift)
        const pLfo = ctx.createOscillator();
        pLfo.frequency.setValueAtTime(0.1 + idx * 0.05, ctx.currentTime);

        const pLfoGain = ctx.createGain();
        pLfoGain.gain.setValueAtTime(1.5, ctx.currentTime); // small shift in Hz

        pLfo.connect(pLfoGain);
        pLfoGain.connect(osc.frequency);
        pLfo.start();
        sources.push(pLfo);
      }
    });

    // Reverb simulation via multiple tape-delay copies with feedback
    try {
      const delayNode = ctx.createDelay(1.0);
      delayNode.delayTime.setValueAtTime(0.6, ctx.currentTime);

      const feedback = ctx.createGain();
      feedback.gain.setValueAtTime(0.45, ctx.currentTime);

      chordGain.connect(delayNode);
      delayNode.connect(feedback);
      feedback.connect(delayNode); // feedback loop
      feedback.connect(dest); // connect to main output
    } catch (e) {
      console.warn('Failed to build starlight delay effect:', e);
    }
  }

  private buildForestRain(ctx: AudioContext, dest: AudioNode, sources: { stop: () => void }[]): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 1. Rain texture: filtered brownian noise
    const rainGain = ctx.createGain();
    rainGain.gain.setValueAtTime(0.35, ctx.currentTime);
    rainGain.connect(dest);

    // Create brown noise buffer
    const bufferSize = ctx.sampleRate * 2.0;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5;
    }

    const rainNoise = ctx.createBufferSource();
    rainNoise.buffer = noiseBuffer;
    rainNoise.loop = true;

    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(1800, ctx.currentTime);
    bpf.Q.setValueAtTime(0.5, ctx.currentTime);

    rainNoise.connect(bpf);
    bpf.connect(rainGain);
    rainNoise.start();
    sources.push(rainNoise);

    // 2. Distant Thunder: low sine waves with random volume triggers
    const thunderOsc = ctx.createOscillator();
    thunderOsc.type = 'sine';
    thunderOsc.frequency.setValueAtTime(80, ctx.currentTime);

    const thunderGain = ctx.createGain();
    thunderGain.gain.setValueAtTime(0.001, ctx.currentTime); // hidden initially

    const thunderLP = ctx.createBiquadFilter();
    thunderLP.type = 'lowpass';
    thunderLP.frequency.setValueAtTime(120, ctx.currentTime);

    thunderOsc.connect(thunderLP);
    thunderLP.connect(thunderGain);
    thunderGain.connect(dest);
    
    thunderOsc.start();
    sources.push(thunderOsc);

    // Random thunder trigger
    let thunderInterval = setInterval(() => {
      if (!this.isEngineRunning || !ctx) {
        clearInterval(thunderInterval);
        return;
      }
      // 15% chance of thunder rumble every 6s
      if (Math.random() > 0.82) {
        const now = ctx.currentTime;
        const rollVol = Math.random() * 0.16 + 0.04;
        const duration = Math.random() * 2.5 + 2.0; // rumble lasts 2-4.5s
        
        thunderGain.gain.setValueAtTime(thunderGain.gain.value, now);
        thunderGain.gain.linearRampToValueAtTime(rollVol, now + 0.4); // soft strike
        thunderGain.gain.exponentialRampToValueAtTime(rollVol * 0.3, now + 1.2); // rumble
        thunderGain.gain.exponentialRampToValueAtTime(0.001, now + duration); // fade out
      }
    }, 6000);

    const originalStop = sources[0].stop;
    sources[0].stop = () => {
      clearInterval(thunderInterval);
      sources.forEach(s => {
        if (s !== rainNoise) {
          try { s.stop(); } catch(e) {}
        }
      });
      try { rainNoise.stop(); } catch(e) {}
    };
  }
}
