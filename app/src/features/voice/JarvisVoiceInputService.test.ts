import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectedStt = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@/features/composer-stt/selectedSttSession', () => ({
  createSelectedSttSession: selectedStt.create,
}));

import { createJarvisVoiceInputService } from './JarvisVoiceInputService';

describe('JarvisVoiceInputService', () => {
  beforeEach(() => {
    selectedStt.create.mockReset();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
  });

  it('routes the voice panel through the one selected STT session', async () => {
    let events: {
      onOpen?: () => void;
      onPartial?: (text: string) => void;
      onFinal?: (text: string) => void;
      onTurnEnd?: () => void;
      onClose?: () => void;
    } = {};
    const session = {
      engine: 'deepgram' as const,
      engineLabel: 'Deepgram · Flux',
      streaming: true,
      stop: vi.fn(async () => events.onClose?.()),
      cancel: vi.fn(() => events.onClose?.()),
      getFinalText: vi.fn(() => 'hello Jarvis'),
    };
    selectedStt.create.mockImplementation(async (nextEvents) => {
      events = nextEvents;
      events.onOpen?.();
      return session;
    });
    const service = createJarvisVoiceInputService();
    const starts = vi.fn();
    const partials = vi.fn();
    const finals = vi.fn();
    const turnEnds = vi.fn();
    service.on('voice:start', starts);
    service.on('voice:partial', partials);
    service.on('voice:final', finals);
    service.on('voice:turn-end', turnEnds);

    expect(service.startListening()).toBe(true);
    expect(service.startListening()).toBe(true);
    await vi.waitFor(() => expect(selectedStt.create).toHaveBeenCalledOnce());
    expect(selectedStt.create).toHaveBeenCalledWith(expect.any(Object), {
      supersedeActive: true,
      requester: 'jarvis-voice',
    });

    events.onPartial?.('hello');
    events.onFinal?.('hello Jarvis');
    events.onTurnEnd?.();
    expect(turnEnds).toHaveBeenCalledOnce();
    expect(starts).toHaveBeenCalledOnce();
    expect(partials).toHaveBeenCalledWith({ text: 'hello' });
    expect(finals).toHaveBeenCalledWith({ text: 'hello Jarvis' });

    service.stopListening();
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce());
    expect(service.wantsListening()).toBe(false);
    service.cancelListening();
    events.onTurnEnd?.();
    expect(turnEnds).toHaveBeenCalledOnce();
  });

  it('cancels a pending selected session without finalizing or emitting transcript', async () => {
    let resolveSession!: (value: {
      engine: 'faster-whisper';
      engineLabel: string;
      streaming: false;
      stop: () => Promise<void>;
      cancel: () => void;
      getFinalText: () => string;
    }) => void;
    const cancel = vi.fn();
    selectedStt.create.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const service = createJarvisVoiceInputService();
    const finals = vi.fn();
    const exclusiveStops = vi.fn();
    service.on('voice:final', finals);
    window.addEventListener('jarvis:voice:exclusive-stop', exclusiveStops);

    service.startListening();
    service.cancelListening();
    resolveSession({
      engine: 'faster-whisper',
      engineLabel: 'Local faster-whisper (small)',
      streaming: false,
      stop: vi.fn(async () => undefined),
      cancel,
      getFinalText: () => '',
    });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(finals).not.toHaveBeenCalled();
    expect(service.isListening()).toBe(false);
    expect(exclusiveStops).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:voice:exclusive-stop', exclusiveStops);
  });

  it('does not announce listening until the selected capture actually opens', async () => {
    let events: { onOpen?: () => void; onClose?: () => void } = {};
    selectedStt.create.mockImplementation(async (nextEvents) => {
      events = nextEvents;
      return {
        engine: 'web-speech',
        engineLabel: 'Built-in speech recognition',
        streaming: true,
        stop: async () => events.onClose?.(),
        cancel: () => events.onClose?.(),
        getFinalText: () => '',
      };
    });
    const service = createJarvisVoiceInputService();
    const starts = vi.fn();
    service.on('voice:start', starts);
    service.startListening();
    await Promise.resolve();
    await Promise.resolve();
    expect.soft(service.isListening()).toBe(false);
    expect.soft(starts).not.toHaveBeenCalled();
    events.onOpen?.();
    expect(service.isListening()).toBe(true);
    expect(starts).toHaveBeenCalledOnce();
    service.cancelListening();
  });

  it('ignores a cancelled startup rejection after a replacement capture opens', async () => {
    let rejectOld!: (error: Error) => void;
    selectedStt.create.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    selectedStt.create.mockImplementationOnce(async (events) => {
      events.onOpen?.();
      return {
        engine: 'deepgram',
        engineLabel: 'Deepgram',
        streaming: true,
        stop: async () => events.onClose?.(),
        cancel: () => events.onClose?.(),
        getFinalText: () => '',
      };
    });
    const service = createJarvisVoiceInputService();
    service.startListening();
    service.cancelListening();
    service.startListening();
    await Promise.resolve();
    expect(service.isListening()).toBe(true);
    rejectOld(new Error('old device request failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isListening()).toBe(true);
    expect(service.wantsListening()).toBe(true);
    service.cancelListening();
  });

  it('publishes a batch final result after capture stops but never reports continued listening', async () => {
    let events: {onOpen?:()=>void;onFinal?:(text:string)=>void;onClose?:()=>void} = {};
    let finish!: () => void;
    selectedStt.create.mockImplementation(async(nextEvents)=>{
      events=nextEvents; events.onOpen?.();
      return {engine:'faster-whisper',engineLabel:'Local faster-whisper',streaming:false,
        stop:()=>new Promise<void>(resolve=>{finish=()=>{events.onFinal?.('safe fixed phrase');events.onClose?.();resolve();};}),
        cancel:()=>events.onClose?.(),getFinalText:()=>''};
    });
    const service=createJarvisVoiceInputService();const onFinal=vi.fn();
    service.on('voice:final',onFinal);service.startListening();
    await vi.waitFor(()=>expect(service.isListening()).toBe(true));
    await Promise.resolve();
    service.stopListening();
    expect.soft(service.isListening()).toBe(false);
    finish();await Promise.resolve();
    expect(onFinal).toHaveBeenCalledExactlyOnceWith({text:'safe fixed phrase'});
  });

  it('reports a safe selected-engine startup failure without leaking raw provider errors', async () => {
    selectedStt.create.mockRejectedValue(new Error('secret=provider-token websocket raw dump'));
    const service = createJarvisVoiceInputService();
    const errors = vi.fn();
    service.on('voice:error', errors);

    service.startListening();

    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    const payload = errors.mock.calls[0]?.[0] as { kind: string; message: string };
    expect(payload.kind).toBe('unknown');
    expect(payload.message).toContain('Speech recognition startup');
    expect(payload.message).not.toContain('provider-token');
    expect(payload.message).not.toContain('websocket raw dump');
  });
});
