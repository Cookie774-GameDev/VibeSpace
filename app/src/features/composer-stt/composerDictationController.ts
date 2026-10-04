import { createSelectedSttSession, type SelectedSttSession } from './selectedSttSession';
import { buildSttCommittedValue, captureSttFieldSnapshot, type SttFieldSnapshot } from './sttInterimEditor';
import { formatGlobalDictationSessionFailure } from '@/features/global-dictation/dictationFailures';

export type ComposerDictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'preview' | 'error';
export interface ComposerDictationSnapshot {
  readonly phase: ComposerDictationPhase;
  readonly text: string;
  readonly partial: boolean;
  readonly engineLabel: string;
  readonly error: string;
}
interface FieldPorts {
  field: () => HTMLTextAreaElement | HTMLInputElement | null;
  commit: (value: string, caret: number) => void;
  onLevel: (level: number) => void;
  scope?: () => string;
}
const idle: ComposerDictationSnapshot = Object.freeze({phase:'idle',text:'',partial:false,engineLabel:'',error:''});

/** One transient edit transaction over the existing selected-STT capture authority.
 * Partial text never mutates the user's draft; only an explicit Accept may commit.
 */
export function createComposerDictationController(ports: FieldPorts) {
  let state = idle;
  const listeners = new Set<() => void>();
  let generation = 0;
  let disposed = false;
  let session: SelectedSttSession | null = null;
  let target: HTMLTextAreaElement | HTMLInputElement | null = null;
  let snapshot: SttFieldSnapshot | null = null;
  let original = '';
  let scope = '';
  let committedText = '';
  let ending = false;
  let finalizing: Promise<void> | null = null;
  let accepting: { generation: number; promise: Promise<string | null> } | null = null;
  const publish = (next: Partial<ComposerDictationSnapshot>) => {
    if (disposed) return;
    state = Object.freeze({...state,...next});
    listeners.forEach(listener => listener());
  };
  const current = (id: number) => !disposed && id === generation && (ports.scope?.() ?? '') === scope;
  const cancel = () => {
    generation += 1;
    const previous = session;
    session = null;target = null;snapshot = null;original = '';committedText = '';
    ending = false;finalizing = null;
    previous?.cancel();ports.onLevel(0);
    publish(idle);
  };
  const fail = (message: string) => {
    const label = state.engineLabel;
    cancel();publish({phase:'error',error:message,engineLabel:label});
  };
  const start = async () => {
    if (disposed) return;
    cancel();
    target = ports.field();
    if (!target) {fail('Focus an editable field before starting dictation.');return;}
    original = target.value;snapshot = captureSttFieldSnapshot(target);scope = ports.scope?.() ?? '';
    const id = generation;
    publish({phase:'starting'});
    try {
      const selected = await createSelectedSttSession({
        onOpen: () => {if(current(id))publish({phase:'listening'});},
        onPartial: text => {
          if(current(id))publish({text:(committedText+' '+text).trim(),partial:true});
        },
        onFinal: text => {
          if(!current(id))return;
          // The shared selected-STT boundary publishes the full final transcript.
          if(text.trim())committedText=text.trim();
          publish({text:committedText,partial:false});
        },
        onLevel: level => {if(current(id))ports.onLevel(level);},
        onError: message => {if(current(id))fail(formatGlobalDictationSessionFailure(message));},
        onClose: () => {
          if(!current(id)||ending||state.phase==='starting')return;
          ports.onLevel(0);
          if(committedText)publish({phase:'preview',text:committedText,partial:false});
          else fail('No speech was captured. Check the microphone and try again.');
        },
      });
      if(!current(id)){selected.cancel();return;}
      session=selected;publish({engineLabel:selected.engineLabel});
    } catch {
      if(current(id))fail('Could not start the selected speech engine. Check microphone permission and the selected model in Settings ? Speech to Text, then retry.');
    }
  };
  const finish = (): Promise<void> => {
    if(finalizing)return finalizing;
    if(!session||state.phase==='preview'||state.phase==='error'||state.phase==='idle')return Promise.resolve();
    const selected=session;const id=generation;
    ending=true;ports.onLevel(0);publish({phase:'transcribing',partial:false});
    finalizing=(async()=>{
      try {
        await selected.stop();
        if(!current(id))return;
        const finalText=selected.getFinalText().trim()||committedText;
        if(!finalText){fail('No speech was captured. Check the microphone and try again.');return;}
        committedText=finalText;publish({phase:'preview',text:finalText,partial:false});
      } catch {
        if(current(id))fail('The selected speech engine could not finish transcription. Check its connection and retry.');
      } finally {
        if(current(id)){ending=false;finalizing=null;}
      }
    })();
    return finalizing;
  };
  const accept = (): Promise<string | null> => {
    const id=generation;
    if(accepting?.generation===id)return accepting.promise;
    const promise=Promise.resolve().then(async()=>{
      if(!current(id))return null;
      if(state.phase!=='preview')await finish();
      if(!current(id)||state.phase!=='preview'||!snapshot||!target)return null;
      if(ports.field()!==target||target.value!==original){
        fail('The draft changed during dictation. Nothing was inserted. Review the draft and retry.');return null;
      }
      const text=state.text.trim();const value=buildSttCommittedValue(snapshot,text);
      if(value===null)return null;
      const caret=value.length-snapshot.after.length;
      // Invalidate callbacks before publishing the one accepted edit.
      cancel();ports.commit(value,caret);
      return value;
    });
    accepting={generation:id,promise};
    const clearAccepting=()=>{if(accepting?.promise===promise)accepting=null;};
    void promise.then(clearAccepting,clearAccepting);
    return promise;
  };
  return {
    getSnapshot:()=>state,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    start,finish,accept,cancel,
    dispose:()=>{if(disposed)return;disposed=true;cancel();listeners.clear();},
  };
}
