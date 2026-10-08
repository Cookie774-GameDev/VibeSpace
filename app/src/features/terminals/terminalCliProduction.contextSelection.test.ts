import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from '@/features/context/contextPersistence';
import type { ProjectContextTree } from '@/features/context/tree';
import { useUIStore } from '@/stores/ui';
const io=vi.hoisted(()=>({service:null as ReturnType<typeof import('@/features/context/contextPersistence').createContextPersistenceService>|null}));
vi.mock('@/features/context',async original=>({
  ...(await original<typeof import('@/features/context')>()),
  loadPersistedContextMaps:async(projectId:string)=>(await io.service!.load('c04-account',projectId)).maps,
  selectPersistedContextFile:async(projectId:string,path:string,target?:{mapId:string;entityId:string})=>io.service!.selectFile('c04-account',projectId,path,target),
}));
import { createProductionTerminalCliRuntimeDependencies } from '@/features/terminals/terminalCliProduction';
let database:JarvisDexie;
const account='c04-account',project='c04-project';
beforeEach(async()=>{
  localStorage.clear();
  database=createJarvisDb(uniqueTestDbName('terminal-open-exact-map'),TEST_INDEXED_DB);
  io.service=createContextPersistenceService(database,localStorage);
  await io.service.initialize(account,project);
  useUIStore.getState().setRoute('chat');
});
afterEach(async()=>{await database.delete();localStorage.clear();vi.restoreAllMocks();});
function tree(root:string,path:string):ProjectContextTree{return {version:1,projectId:project,rootDir:root,generatedAt:1,model:'siyuan-managed-v1',fileCount:1,totalBytes:4,summary:'Public synthetic source only',nodes:[{id:'file',kind:'file',title:path,path,summary:'',sizeBytes:4,modifiedAt:1}]};}
it.each([false,true])('opens the resolved entity in its exact map when a sibling relative path overlaps=%s',async overlap=>{
  await io.service!.saveTree(account,tree('C:/owned-c04/A','same.txt'),{mapId:'c04-map-a',name:'A',sourceStatus:'ready'});
  await io.service!.saveTree(account,tree('C:/owned-c04/B',overlap?'same.txt':'other.txt'),{mapId:'c04-map-b',name:'B',sourceStatus:'ready'});
  const before=await io.service!.load(account,project);
  expect(before.maps).toHaveLength(2);
  // Deliberately target the later map in the actual durable load order. This
  // avoids assuming sort behavior while ensuring a possible earlier owner.
  const target=before.maps[1]!;
  const targetNode=target.tree.nodes[0]!;
  const dependencies=createProductionTerminalCliRuntimeDependencies();
  const selected=await dependencies.resolveContextEntity(project,targetNode.id);
  expect(selected).toMatchObject({id:targetNode.id,mapId:target.id,path:targetNode.path});
  await dependencies.openContextEntity(project,selected!);
  const after=await io.service!.load(account,project);
  expect(useUIStore.getState().route).toBe('context');
  expect(after.selectedMapId).toBe(target.id);
  expect(after.selectedFile).toBe(targetNode.path);
});


it.each(['deleted-map','replaced-entity'] as const)('refuses an already resolved %s without opening its path peer',async change=>{
  await io.service!.saveTree(account,tree('C:/owned-c04/A','same.txt'),{mapId:'c04-map-a',sourceStatus:'ready'});
  await io.service!.saveTree(account,tree('C:/owned-c04/B','same.txt'),{mapId:'c04-map-b',sourceStatus:'ready'});
  const before=await io.service!.load(account,project);
  const target=before.maps[1]!;
  const dependencies=createProductionTerminalCliRuntimeDependencies();
  const selected=await dependencies.resolveContextEntity(project,target.tree.nodes[0]!.id);
  expect(selected?.mapId).toBe(target.id);
  if(change==='deleted-map')await io.service!.deleteMap(account,project,target.id);
  else {
    const replacement=tree(target.rootDir,'same.txt');
    replacement.nodes[0]!.id='replacement';
    await io.service!.saveTree(account,replacement,{mapId:target.id,sourceStatus:'ready',select:false});
  }
  const settings=await database.settings.toArray();
  await expect(dependencies.openContextEntity(project,selected!)).rejects.toThrow();
  expect(await database.settings.toArray()).toEqual(settings);
  expect(useUIStore.getState().route).toBe('chat');
});


it.each(['symbol','note'] as const)('preserves an exact %s containing-file projection in the qualified map',async kind=>{
  for(const [mapId,root] of [['c04-map-a','C:/owned-c04/A'],['c04-map-b','C:/owned-c04/B']]) {
    const source=tree(root!,'same.txt');
    source.nodes[0]!.children=[{id:'child',kind,title:'Owned child',path:'same.txt',summary:'Source member'}];
    await io.service!.saveTree(account,source,{mapId,sourceStatus:'ready'});
  }
  const state=await io.service!.load(account,project);
  const map=state.maps[1]!;
  const child=map.tree.nodes[0]!.children![0]!;
  const dependencies=createProductionTerminalCliRuntimeDependencies();
  const resolved=await dependencies.resolveContextEntity(project,child.id);
  expect(resolved).toMatchObject({id:child.id,mapId:map.id,path:'same.txt'});
  await dependencies.openContextEntity(project,resolved!);
  const selected=await io.service!.load(account,project);
  expect(selected.selectedMapId).toBe(map.id);
  expect(selected.selectedFile).toBe('same.txt');
  expect(useUIStore.getState().route).toBe('context');
});

it.each(['symbol','note'] as const)('rejects a qualified %s whose path or map does not match the resolved entity',async kind=>{
  for(const [mapId,root] of [['c04-map-a','C:/owned-c04/A'],['c04-map-b','C:/owned-c04/B']]) {
    const source=tree(root!,'same.txt');
    source.nodes[0]!.children=[{id:'child',kind,title:'Owned child',path:'same.txt',summary:'Source member'}];
    source.nodes.push({id:'other-file',kind:'file',title:'other.txt',path:'other.txt',summary:'',sizeBytes:4,modifiedAt:1});
    source.fileCount=2; source.totalBytes=8;
    await io.service!.saveTree(account,source,{mapId,sourceStatus:'ready'});
  }
  const state=await io.service!.load(account,project);
  const map=state.maps[1]!,foreign=state.maps[0]!;
  const child=map.tree.nodes[0]!.children![0]!;
  const dependencies=createProductionTerminalCliRuntimeDependencies();
  const resolved=(await dependencies.resolveContextEntity(project,child.id))!;
  expect(resolved.mapId).toBe(map.id);
  const settings=await database.settings.toArray();
  await expect(dependencies.openContextEntity(project,{...resolved,mapId:foreign.id})).rejects.toThrow();
  await expect(dependencies.openContextEntity(project,{...resolved,path:'other.txt'})).rejects.toThrow();
  expect(await database.settings.toArray()).toEqual(settings);
  expect(useUIStore.getState().route).toBe('chat');
});
