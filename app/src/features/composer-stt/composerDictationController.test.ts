import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationEvents } from '@/features/global-dictation/deepgramDictation';
const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./selectedSttSession', () => ({ createSelectedSttSession: engine.create }));
import { createComposerDictationController } from './composerDictationController';

describe('Composer selected-STT field transactions', () => {
  let field: HTMLTextAreaElement;
  let events: DictationEvents;
  let finalText: string;
  let cancel: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let commit: ReturnType<typeof vi.fn<(value: string, caret: number) => void>>;
  beforeEach(() => {
    field = document.createElement('textarea');
    field.value = 'alpha old words omega';
    field.setSelectionRange(6,15);
    events = {}; finalText = '';
    cancel = vi.fn(() => events.onClose?.());
    stop = vi.fn(async () => { events.onFinal?.(finalText);events.onClose?.(); });
    commit = vi.fn((value:string,caret:number) => {field.value=value;field.setSelectionRange(caret,caret);});
    engine.create.mockReset().mockImplementation(async (next:DictationEvents) => {
      events=next;events.onOpen?.();
      return {engine:'faster-whisper',engineLabel:'Local faster-whisper',streaming:false,stop,cancel,getFinalText:()=>finalText};
    });
  });
  function make() { return createComposerDictationController({ field:()=>field, commit, onLevel:vi.fn() }); }

  it('keeps partial/final preview separate, replacing the captured selection once on Accept', async () => {
    const c=make();await c.start();
    events.onPartial?.('safe fixed');
    expect(field.value).toBe('alpha old words omega');
    expect([field.selectionStart,field.selectionEnd]).toEqual([6,15]);
    expect(c.getSnapshot().partial).toBe(true);
    finalText='safe fixed phrase';await c.finish();
    expect(c.getSnapshot()).toMatchObject({phase:'preview',text:finalText,partial:false});
    expect(commit).not.toHaveBeenCalled();
    expect(await Promise.all([c.accept(),c.accept()])).toEqual([
      'alpha safe fixed phrase omega',
      'alpha safe fixed phrase omega',
    ]);
    expect(field.value).toBe('alpha safe fixed phrase omega');
    expect(field.selectionStart).toBe(23);
    expect(commit).toHaveBeenCalledOnce();
    c.dispose();
  });

  it('inserts at the original caret rather than appending at the end', async () => {
    field.value='before after';field.setSelectionRange(7,7);
    const c=make();await c.start();finalText='middle';await c.finish();await c.accept();
    expect(field.value).toBe('before middle after');expect(commit).toHaveBeenCalledOnce();c.dispose();
  });

  it('does not duplicate cumulative final results when the engine ends naturally', async () => {
    const c=make();await c.start();
    events.onFinal?.('hello');events.onFinal?.('hello world');events.onClose?.();
    await c.accept();
    expect(field.value).toBe('alpha hello world omega');
    expect(commit).toHaveBeenCalledOnce();c.dispose();
  });

  it('cancel leaves selected text intact and ignores late final and energy callbacks', async () => {
    const level=vi.fn();const c=createComposerDictationController({field:()=>field,commit,onLevel:level});
    await c.start();events.onPartial?.('do not insert');const late=events;
    c.cancel();const calls=level.mock.calls.length;
    late.onFinal?.('stale');late.onLevel?.(0.9);late.onOpen?.();
    expect(field.value).toBe('alpha old words omega');expect(commit).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('idle');expect(cancel).toHaveBeenCalledOnce();
    expect(level).toHaveBeenCalledTimes(calls);c.dispose();
  });

  it('cancels transcription immediately and cannot accept its delayed result', async () => {
    let done!:()=>void;stop.mockImplementation(()=>new Promise<void>(resolve=>{done=resolve;}));
    const c=make();await c.start();const accepting=c.accept();
    await Promise.resolve();expect(c.getSnapshot().phase).toBe('transcribing');c.cancel();
    finalText='discard';events.onFinal?.(finalText);done();expect(await accepting).toBeNull();
    expect(commit).not.toHaveBeenCalled();expect(c.getSnapshot().phase).toBe('idle');c.dispose();
  });

  it('does not overwrite a draft edited after microphone activation', async () => {
    const c=make();await c.start();field.value='new user draft';finalText='dictation';
    await c.finish();await c.accept();
    expect(field.value).toBe('new user draft');expect(commit).not.toHaveBeenCalled();
    expect(c.getSnapshot()).toMatchObject({phase:'error'});expect(c.getSnapshot().error).toMatch(/draft changed/i);c.dispose();
  });

  it('cleans up a pending start after navigation and does not publish state', async () => {
    let resolve!: (value:unknown)=>void;
    engine.create.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const c=make();const listener=vi.fn();c.subscribe(listener);const starting=c.start();
    c.dispose();const calls=listener.mock.calls.length;
    resolve({engine:'web-speech',engineLabel:'System',streaming:true,stop,cancel,getFinalText:()=>''});
    await starting;expect(cancel).toHaveBeenCalledOnce();expect(listener).toHaveBeenCalledTimes(calls);expect(commit).not.toHaveBeenCalled();
  });

  it('reports empty audio and startup errors without inserting or auto-sending', async () => {
    const send=vi.fn();window.addEventListener('jarvis:send',send);
    const c=make();try {
      await c.start();await c.finish();expect(c.getSnapshot().phase).toBe('error');expect(commit).not.toHaveBeenCalled();
      engine.create.mockRejectedValueOnce(new Error('raw secret=do-not-show'));
      await c.start();expect(c.getSnapshot().phase).toBe('error');expect(c.getSnapshot().error).not.toContain('do-not-show');
      expect(send).not.toHaveBeenCalled();
    } finally {c.dispose();window.removeEventListener('jarvis:send',send);}
  });
});
