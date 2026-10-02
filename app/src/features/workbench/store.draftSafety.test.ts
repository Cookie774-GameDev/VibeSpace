import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkbenchStore } from './store';
const file=String.raw`C:\S61B1\exact-file.txt`;
beforeEach(()=>{
  window.localStorage.clear();
  useWorkbenchStore.setState({panels:[],history:[],future:[],selectedIds:[]});
});
function editor(note: string){
  const id=useWorkbenchStore.getState().addPanel('editor',undefined,{note,language:'text'});
  if(!id)throw Error('Could not create disposable editor');
  return id;
}
describe('Workbench file opening preserves drafts',()=>{
  it('creates a distinct editor and preserves a nonempty large unsaved draft',()=>{
    const content='S61B1 draft Ω\n'.repeat(5000);
    const draft=editor(content);
    const original=structuredClone(useWorkbenchStore.getState().panels.find(p=>p.id===draft));
    const opened=useWorkbenchStore.getState().openFileInEditor(file);
    expect(opened).not.toBe(draft);
    const state=useWorkbenchStore.getState();
    expect(state.panels).toHaveLength(2);
    expect(state.panels.find(p=>p.id===draft)).toEqual(original);
    expect(state.panels.find(p=>p.id===opened)?.settings.filePath).toBe(file);
  });
  it('preserves whitespace-only draft content exactly',()=>{
    const draft=editor(' \n\t\n');
    const opened=useWorkbenchStore.getState().openFileInEditor(file);
    expect(opened).not.toBe(draft);
    expect(useWorkbenchStore.getState().panels.find(p=>p.id===draft)?.settings.note).toBe(' \n\t\n');
  });
  it('reuses a truly empty editor without creating an extra panel',()=>{
    const empty=editor('');
    expect(useWorkbenchStore.getState().openFileInEditor(file)).toBe(empty);
    expect(useWorkbenchStore.getState().panels).toHaveLength(1);
    expect(useWorkbenchStore.getState().panels[0].settings.filePath).toBe(file);
  });
  it('reuses an already-open exact file while leaving another draft alone',()=>{
    const draft=editor('S61B1 protected unsaved text');
    const existing=useWorkbenchStore.getState().addPanel('editor',undefined,{filePath:file,note:'disk snapshot'});
    expect(useWorkbenchStore.getState().openFileInEditor(file)).toBe(existing);
    expect(useWorkbenchStore.getState().panels).toHaveLength(2);
    expect(useWorkbenchStore.getState().panels.find(p=>p.id===draft)?.settings.note).toBe('S61B1 protected unsaved text');
  });
});
