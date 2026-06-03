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
      
      // Master volume scale: keep ambient drone very quiet (max ~0.15 scale at 100%)
      this.updateMasterVolume();
    }
    
    void this.resume();
    return this.ctx;
  }

  private updateMasterVolume(): void {
    if (!this.masterGain || !this.ctx) return;
    const targetGain = (this.currentVolumePercent / 100) * 0.15;
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
    if (track === 'warm-hearth') {
      this.buildWarmHearth(ctx, trackGain, sources);
    } else if (track === 'deep-ocean') {
      this.buildDeepOcean(ctx, trackGain, sources);
    } else if (track === 'starlight') {
      this.buildStarlight(ctx, trackGain, sources);
    } else if (track === 'forest-rain') {
      this.buildForestRain(ctx, trackGain, sources);
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
