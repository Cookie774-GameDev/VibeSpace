import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from '@/features/context/contextPersistence';
import { createHash } from 'node:crypto';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { buildProjectContextTreeFromSiyuanIndex, type SiyuanSafeIndex } from '@/features/context/siyuan/siyuanSafeIndex';
import type { ContextMapRecord, ProjectContextTree } from '@/features/context/tree';
import { useUIStore } from '@/stores/ui';
const io=vi.hoisted(()=>({write:vi.fn(),sync:vi.fn(),readMaps:vi.fn(),jobStatus:'completed',root:'C:/owned-c08-readonly',nativeCalls:[] as Array<{command:string;request:any}>,service:null as ReturnType<typeof import('@/features/context/contextPersistence').createContextPersistenceService>|null}));
vi.mock('@/lib/fs',async original=>({
  ...(await original<typeof import('@/lib/fs')>()),
  listDirectory:async(path:string)=>({ok:true,path,entries:[{name:'same.txt',path:`${path}/same.txt`,isDir:false,size:4,modifiedMs:2}]}),
  listDirectoriesStrict:async(paths:readonly string[])=>paths.map(path=>({ok:true,path,entries:[{name:'same.txt',path:`${path}/same.txt`,isDir:false,size:4,modifiedMs:2}]})),
  statProjectPath:async(path:string,sha:boolean)=>({ok:true,path,kind:'file',size:4,modifiedMs:2,...(sha?{sha256:`sha256:${createHash('sha256').update('new!').digest('hex')}`}:{})}),
  sha256Text:async(text:string)=>`sha256:${createHash('sha256').update(text).digest('hex')}`,
  readTextFileSample:async(path:string)=>({ok:true,path,content:'new!',truncated:false}),
  writeTextFile:(...args:unknown[])=>io.write(...args),
}));
vi.mock('@/features/context',async original=>({
  ...(await original<typeof import('@/features/context')>()),
  loadPersistedContextMaps:(projectId:string)=>io.readMaps(projectId),
  reloadPersistedContextMaps:(projectId:string)=>io.readMaps(projectId),
  selectPersistedContextFile:async(projectId:string,path:string,target?:{mapId:string;entityId:string})=>io.service!.selectFile('c04-account',projectId,path,target),
  savePersistedContextTree:async(tree:ProjectContextTree,options:any)=>io.service!.saveTree('c04-account',tree,options),
}));
vi.mock('@/features/context/contextPersistence',async original=>({
  ...(await original<typeof import('@/features/context/contextPersistence')>()),
  captureContextPersistenceScope:async(accountId:string,projectId:string)=>({
    accountId,projectId,
    loadMap:(mapId:string)=>io.service!.loadMap(accountId,projectId,mapId),
    captureMapRestore:(mapId:string,revision:number)=>io.service!.captureMapRestore(accountId,projectId,mapId,revision),
    saveExistingTree:(tree:ProjectContextTree,options:import('@/features/context/contextPersistence').ContextTreeSaveOptions)=>io.service!.saveTree(accountId,tree,{...options,requireExisting:true}),
  }),
}));
vi.mock('@/features/context/siyuan/siyuanMapManifest',async original=>({
  ...(await original<typeof import('@/features/context/siyuan/siyuanMapManifest')>()),
  readSiyuanMapManifest:()=>({status:'ready',sourceRoot:io.root,sourcePolicy:{excludedPaths:[]}}),
}));
vi.mock('@/features/context/siyuan/siyuanIndexJobStore',async original=>({
  ...(await original<typeof import('@/features/context/siyuan/siyuanIndexJobStore')>()),
  readSiyuanIndexJob:async()=>({status:io.jobStatus,accountId:'c04-account',canonicalRoot:io.root}),
}));
vi.mock('@/features/context/siyuanContextMapIntegration',async original=>({
  ...(await original<typeof import('@/features/context/siyuanContextMapIntegration')>()),
  productionSiyuanContextMaps:{sync:(...args:unknown[])=>io.sync(...args)},
}));
vi.mock('@tauri-apps/api/core',()=>({
  invoke:async(command:string,{request}:{request:any})=>{
    io.nativeCalls.push({command,request:structuredClone(request)});
    if(command==='context_search_status')return {documentCount:1,indexId:'fixture-index',engine:'tantivy-0.22.1',schemaVersion:1,needsRebuild:false,recoveredCorruption:false};
    if(command==='context_search_begin_refresh')return 't'.repeat(32);
    if(command==='context_search_stage_refresh')return;
    if(command==='context_search_finish_refresh')return 1;
    throw new Error(`Unexpected native command: ${command}`);
  },
}));
import { createProductionContextAutoUpdater } from '@/features/context/contextAutoUpdate';
import { createProductionTerminalCliRuntimeDependencies } from '@/features/terminals/terminalCliProduction';
let database:JarvisDexie;
const account='c04-account',project='c04-project';
beforeEach(async()=>{
  localStorage.clear();
  io.write.mockReset();io.write.mockResolvedValue({ok:true});
  io.jobStatus='completed';io.nativeCalls=[];io.root='C:/owned-c08-readonly';
  io.readMaps.mockReset();io.readMaps.mockImplementation(async(projectId:string)=>(await io.service!.load('c04-account',projectId)).maps);
  io.sync.mockReset();io.sync.mockImplementation(async(_project:string,map:ContextMapRecord,options:{preScannedIndex:SiyuanSafeIndex})=>({tree:buildProjectContextTreeFromSiyuanIndex(map.tree,options.preScannedIndex.entries)}));
  useAuthStore.setState({localUserId:account,cloudSession:null,workspaceId:'c08-workspace' as WorkspaceId,projectId:project as ProjectId});
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


it('C08 refreshes a readable managed source without writing into its read-only root',async()=>{
  const initial=tree('C:/owned-c08-readonly','same.txt');
  initial.model='siyuan-managed-v1';
  await io.service!.saveTree(account,initial,{mapId:'c08-readonly-map',sourceStatus:'ready'});
  io.write.mockResolvedValue({ok:false,error:{code:'permission_denied',raw:'Fixture root is read-only'}});
  const dependencies=createProductionTerminalCliRuntimeDependencies();
  let result:unknown,error:unknown;
  try {result=await dependencies.refreshContextMap(project,'c08-readonly-map');}catch(caught){error=caught;}
  console.log('C08_REFRESH_JOIN',JSON.stringify({writeAttempts:io.write.mock.calls.map(call=>({path:call[0],options:call[2]})),result,error:error instanceof Error?error.message:String(error)}));
  expect(io.write).not.toHaveBeenCalled();
  expect(error).toBeUndefined();
  expect(result).toMatchObject({id:'c08-readonly-map',status:'active'});
  expect(io.sync).toHaveBeenCalledOnce();
  expect(io.sync.mock.calls[0]![2]).toMatchObject({automaticRefresh:true,forceReconcile:true,accountId:account,workspaceId:'c08-workspace'});
  const stages=io.nativeCalls.filter(call=>call.command==='context_search_stage_refresh');
  expect(stages.some(call=>call.request.documents.some((doc:{documentId:string;text:string})=>doc.documentId==='c08-readonly-map:path:same.txt' && JSON.stringify(doc).includes('new!')))).toBe(true);
  expect(io.nativeCalls.at(-1)).toMatchObject({command:'context_search_finish_refresh',request:{commit:true}});
  const saved=(await io.service!.load(account,project)).maps.find(map=>map.id==='c08-readonly-map')!;
  expect(saved.tree.nodes[0]).toMatchObject({id:'c08-readonly-map:path:same.txt',path:'same.txt',modifiedAt:2});
});


it.each(['paused','cancelled','running','failed'])('C08 refuses an initial durable job that is %s',async status=>{
  await io.service!.saveTree(account,tree(io.root,'same.txt'),{mapId:'c08-readonly-map',sourceStatus:'ready'});
  io.jobStatus=status;
  await expect(createProductionTerminalCliRuntimeDependencies().refreshContextMap(project,'c08-readonly-map')).rejects.toThrow('initial_map_not_ready');
  expect(io.sync).not.toHaveBeenCalled();expect(io.nativeCalls).toEqual([]);expect(io.write).not.toHaveBeenCalled();
});

it.each(['account','workspace','project'] as const)('C08 revokes a terminal refresh on %s ABA during its first map read',async field=>{
  await io.service!.saveTree(account,tree(io.root,'same.txt'),{mapId:'c08-readonly-map',sourceStatus:'ready'});
  const before=useAuthStore.getState();
  io.readMaps.mockImplementationOnce(async(projectId:string)=>{
    if(field==='account')useAuthStore.setState({localUserId:'foreign'});
    if(field==='workspace')useAuthStore.setState({workspaceId:'foreign' as WorkspaceId});
    if(field==='project')useAuthStore.setState({projectId:'foreign' as ProjectId});
    useAuthStore.setState({localUserId:before.localUserId,workspaceId:before.workspaceId,projectId:before.projectId});
    return (await io.service!.load(account,projectId)).maps;
  });
  await expect(createProductionTerminalCliRuntimeDependencies().refreshContextMap(project,'c08-readonly-map')).rejects.toThrow();
  expect(io.sync).not.toHaveBeenCalled();expect(io.nativeCalls).toEqual([]);expect(io.write).not.toHaveBeenCalled();
});


it('C08 refuses a second production updater while native synchronization is held',async()=>{
  await io.service!.saveTree(account,tree(io.root,'same.txt'),{mapId:'c08-readonly-map',sourceStatus:'ready'});
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  io.sync.mockImplementationOnce(async(_project:string,map:ContextMapRecord,options:{preScannedIndex:SiyuanSafeIndex})=>{
    await held;return {tree:buildProjectContextTreeFromSiyuanIndex(map.tree,options.preScannedIndex.entries)};
  });
  const first=createProductionTerminalCliRuntimeDependencies().refreshContextMap(project,'c08-readonly-map');
  await vi.waitFor(()=>expect(io.sync).toHaveBeenCalledOnce());
  const second=await createProductionContextAutoUpdater({accountId:account,workspaceId:'c08-workspace',projectId:project,mapId:'c08-readonly-map'});
  await expect(second.refresh(new AbortController().signal)).rejects.toThrow('busy');
  expect(io.nativeCalls.filter(call=>call.command==='context_search_begin_refresh')).toHaveLength(1);
  release();await first;
  expect(io.write).not.toHaveBeenCalled();
});
