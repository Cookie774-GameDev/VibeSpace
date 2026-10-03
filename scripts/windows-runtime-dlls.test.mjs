import assert from 'node:assert/strict';
import test from 'node:test';
import {selectRequiredDlls} from './prepare-windows-runtime-dlls.mjs';
import {resolveResourceTargets} from './s61-nsis-reinspect.mjs';
import path from 'node:path';

const edges=[
  {module:'jarvis.exe',imported:'directml.dll',kind:'packaged'},
  {module:'jarvis.exe',imported:'msvcp140.dll',kind:'packaged'},
  {module:'jarvis.exe',imported:'msvcp140_1.dll',kind:'packaged'},
  {module:'directml.dll',imported:'vcruntime140.dll',kind:'packaged'},
  {module:'vcruntime140.dll',imported:'directml.dll',kind:'packaged'},
  {module:'jarvis.exe',imported:'kernel32.dll',kind:'system'},
  {module:'unrelated.dll',imported:'unused.dll',kind:'packaged'},
];
test('DLL packaging selects exactly the executable-reachable local closure, including cycles',()=>{
  assert.deepEqual([...selectRequiredDlls(edges)].sort(),['directml.dll','msvcp140.dll','msvcp140_1.dll','vcruntime140.dll']);
});
for(const required of ['directml.dll','msvcp140.dll','msvcp140_1.dll'])test(`required executable import ${required} cannot disappear`,()=>{
  assert.throws(()=>selectRequiredDlls(edges.filter(edge=>edge.imported!==required)),/dependency contract changed/u);
});
test('system and unrelated DLLs cannot become deployment inputs',()=>{
  const result=selectRequiredDlls(edges);assert(!result.has('kernel32.dll'));assert(!result.has('unused.dll'));
});
const base=path.resolve('fixture/app/src-tauri');
const file=relative=>path.resolve(base,...relative.split('/'));
test('map directory resources retain nested files and DLL resources install beside the executable',()=>{
  const result=resolveResourceTargets({'resources/siyuan-runtime/':'resources/siyuan-runtime/','resources/windows-runtime-dlls/':''},[
    file('resources/siyuan-runtime/nested/data.bin'),file('resources/windows-runtime-dlls/DirectML.dll')],base);
  assert.equal(result.get('resources/siyuan-runtime/nested/data.bin').target,'resources/siyuan-runtime/nested/data.bin');
  assert.equal(result.get('directml.dll').target,'DirectML.dll');
});
test('legacy resources preserve parent directories as literal _up_ segments',()=>{
  const result=resolveResourceTargets(['../../docs/oss/THIRD_PARTY_NOTICES.md'],[file('../../docs/oss/THIRD_PARTY_NOTICES.md')],base);
  assert.equal(result.values().next().value.target,'_up_/_up_/docs/oss/THIRD_PARTY_NOTICES.md');
});
test('a mapped glob follows Tauri flattening and rejects resulting destination collisions',()=>{
  assert.throws(()=>resolveResourceTargets({'resources/intro/**/*':'intro/'},[file('resources/intro/one/a.png'),file('resources/intro/two/a.png')],base),/collision/u);
});
test('resource mapping rejects missing matches, unsafe destinations and empty contracts',()=>{
  assert.throws(()=>resolveResourceTargets({'missing/':''},[file('resources/a.bin')],base),/matched nothing/u);
  assert.throws(()=>resolveResourceTargets({'resources/a.bin':'../outside'},[file('resources/a.bin')],base),/traversal/u);
  assert.throws(()=>resolveResourceTargets({},[],base),/Nonempty/u);
});
