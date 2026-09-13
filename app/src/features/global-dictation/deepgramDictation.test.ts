import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepgramListenUrl, parseDeepgramMessage, createDeepgramDictationSession } from './deepgramDictation';

describe('deepgramListenUrl', () => {
  it('requests realtime smart-formatted dictation with interim results', () => {
    const url = new URL(deepgramListenUrl('nova-3-mono'));

    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('interim_results')).toBe('true');
  });

  it('routes Flux presets through the required v2 endpoint', () => {
    const url = new URL(deepgramListenUrl('flux-en'));
    expect(url.pathname).toBe('/v2/listen');
    expect(url.searchParams.get('model')).toBe('flux-general-en');
    expect(url.searchParams.has('smart_format')).toBe(false);
  });

  it('normalizes Nova interim/final and Flux turn messages into one dictation contract', () => {
    expect(
      parseDeepgramMessage({
        channel: { alternatives: [{ transcript: 'working' }] },
        is_final: false,
      }),
    ).toEqual({ kind: 'partial', transcript: 'working' });
    expect(
      parseDeepgramMessage({
        channel: { alternatives: [{ transcript: 'done' }] },
        speech_final: true,
      }),
    ).toEqual({ kind: 'final', transcript: 'done' });
    expect(
      parseDeepgramMessage({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'flux done',
      }),
    ).toEqual({ kind: 'final', transcript: 'flux done' });
    expect(
      parseDeepgramMessage({
        type: 'TurnInfo',
        event: 'Update',
        transcript: 'flux working',
      }),
    ).toEqual({ kind: 'partial', transcript: 'flux working' });
  });
});

vi.mock('@/lib/security/voiceKeys', () => ({ getDeepgramVoiceKey: async () => 'disposable-test-key' }));

describe('Deepgram capture and finalization ownership', () => {
  it('reports confirmed Flux turn end after its final transcript, never for eager guesses', async () => {
    const order: string[] = [];
    const session = await createDeepgramDictationSession({
      onFinal: (text) => order.push(text),
      onTurnEnd: () => order.push('turn-end'),
    }, 'flux-en');
    const socket = sockets[0]!;
    socket.open();
    try {
      socket.onmessage?.({ data: JSON.stringify({ type: 'TurnInfo', event: 'EagerEndOfTurn', transcript: 'hello' }) } as MessageEvent);
      expect(order).toEqual([]);
      socket.onmessage?.({ data: JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'hello' }) } as MessageEvent);
      expect(order).toEqual(['hello', 'turn-end']);
    } finally { session.cancel(); }
  });

  let sockets: SocketFixture[];
  let stopTrack: ReturnType<typeof vi.fn>;
  let closeContext: ReturnType<typeof vi.fn>;
  let frame: FrameRequestCallback | undefined;
  let sample: number;

  class SocketFixture {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    sent: unknown[] = [];
    constructor() { sockets.push(this); }
    send(data: unknown) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    transcript(text: string) {
      this.onmessage?.({data: JSON.stringify({channel:{alternatives:[{transcript:text}]},is_final:true})});
    }
  }
  class RecorderFixture {
    static isTypeSupported = () => true;
    state = 'inactive';
    ondataavailable: ((event: {data: {size:number;arrayBuffer:()=>Promise<ArrayBuffer>}}) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({data:{size:2,arrayBuffer:async()=>new ArrayBuffer(2)}});
      this.onstop?.();
    }
  }
  beforeEach(() => {
    sockets = []; sample = 128; frame = undefined;
    stopTrack = vi.fn(); closeContext = vi.fn(async () => undefined);
    const track = {stop:stopTrack,addEventListener:vi.fn(),removeEventListener:vi.fn()};
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
    vi.stubGlobal('WebSocket',SocketFixture);
    vi.stubGlobal('MediaRecorder',RecorderFixture);
    vi.stubGlobal('AudioContext',class {
      createMediaStreamSource() { return {connect:vi.fn(),disconnect:vi.fn()}; }
      createAnalyser() { return {fftSize:256,frequencyBinCount:128,getByteTimeDomainData:(data:Uint8Array)=>data.fill(sample),disconnect:vi.fn()}; }
      close = closeContext;
    });
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frame=callback;return 1;});
    vi.stubGlobal('cancelAnimationFrame',vi.fn());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('flushes the final audio before CloseStream and awaits the server final transcript', async () => {
    const onFinal = vi.fn();
    const session = await createDeepgramDictationSession({onFinal},'nova-3-mono');
    const socket = sockets[0]!; socket.open();
    let settled = false;
    const stopping = Promise.resolve(session.stop()).then(()=>{settled=true;});
    await vi.waitFor(() => expect(socket.sent.some(v=>typeof v==='string' && JSON.parse(v).type==='CloseStream')).toBe(true));
    expect.soft(settled).toBe(false);
    expect.soft(socket.sent.some(v=>typeof v==='string' && JSON.parse(v).type==='CloseStream')).toBe(true);
    expect.soft(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect.soft(stopTrack).toHaveBeenCalledOnce();
    socket.transcript('A harmless fixed phrase.'); socket.close();
    await stopping;
    expect(session.getFinalText()).toBe('A harmless fixed phrase.');
    expect(onFinal).toHaveBeenCalledExactlyOnceWith('A harmless fixed phrase.');
  });

  it('keeps an hour-long streaming take alive and accumulates every confirmed segment', async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const session = await createDeepgramDictationSession({onFinal}, 'nova-3-mono');
    const socket = sockets[0]!;
    socket.open();
    const segments: string[] = [];
    for (let minute = 0; minute < 60; minute++) {
      segments.push(`minute ${minute}`);
      socket.transcript(segments.at(-1)!);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(stopTrack).not.toHaveBeenCalled();
    expect(session.getFinalText()).toBe(segments.join(' '));
    expect(onFinal).toHaveBeenCalledTimes(60);
    session.cancel();
  });

  it('uses microphone samples instead of transcript length and cleans its audio graph', async () => {
    const onLevel = vi.fn();
    const session = await createDeepgramDictationSession({onLevel},'nova-3-mono');
    const socket=sockets[0]!;socket.open();
    try {
      sample=136;frame?.(1);
      expect.soft(onLevel).toHaveBeenLastCalledWith(0.5);
      socket.transcript('text must not fabricate waveform energy');
      expect.soft(onLevel).toHaveBeenLastCalledWith(0.5);
      sample=128;frame?.(2);
      expect.soft(onLevel).toHaveBeenLastCalledWith(0);
    } finally { socket.close(); }
    expect(closeContext).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('requests audio resume without blocking speech on an autoplay gate', async () => {
    const original = globalThis.AudioContext;
    const resume = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('AudioContext', class extends original {
      readonly state = 'suspended' as const;
      resume = resume;
    });
    const session = await createDeepgramDictationSession({}, 'nova-3-mono');
    expect(resume).toHaveBeenCalledOnce();
    session.cancel();
  });

  it('releases an acquired stream when the recording constructor fails', async () => {
    vi.stubGlobal('MediaRecorder',class { static isTypeSupported=()=>true; constructor(){throw Error('recording unavailable');} });
    await expect(createDeepgramDictationSession({},'nova-3-mono')).rejects.toThrow('recording unavailable');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sockets.every(socket=>socket.readyState===SocketFixture.CLOSED)).toBe(true);
  });

  it('cancels immediately and rejects late final callbacks without retained text', async () => {
    const onFinal=vi.fn();const onClose=vi.fn();
    const session=await createDeepgramDictationSession({onFinal,onClose},'nova-3-mono');
    const socket=sockets[0]!;socket.open();
    const late=socket.onmessage!;
    try {
      expect.soft('cancel' in session).toBe(true);
      if('cancel' in session)(session as {cancel:()=>void}).cancel();else socket.close();
      late({data:JSON.stringify({channel:{alternatives:[{transcript:'late private words'}]},is_final:true})});
      expect(session.getFinalText()).toBe('');
      expect(onFinal).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    } finally { socket.close(); }
  });
});
