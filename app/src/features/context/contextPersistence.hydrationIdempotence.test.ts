import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from './contextPersistence';
import { currentMembershipDigest } from './contextIssuedEvidenceRegistry';
import type { ContextMapRecord, ProjectContextTree } from './tree';

let database: JarvisDexie;
let service: ReturnType<typeof createContextPersistenceService>;
let tree: ProjectContextTree;
let map: ContextMapRecord;
const accountId='hydration-account';
const mapId='hydration-map';
const scope={accountId,workspaceId:'hydration-workspace',projectId:'hydration-project',worktreeId:'/'};
beforeEach(async()=>{
  localStorage.clear();
  database=createJarvisDb(uniqueTestDbName('hydration-equivalence'),TEST_INDEXED_DB);
  service=createContextPersistenceService(database,localStorage);
  await service.initialize(accountId,scope.projectId);
  tree={version:1,projectId:scope.projectId,rootDir:'C:/stable',generatedAt:1000,
    model:'siyuan-managed-v1',fileCount:2,totalBytes:12,summary:'Stable source',
    nodes:[{id:'folder',kind:'area',title:'Nested',summary:'',path:'nested',modifiedAt:100,
      children:[{id:'one',kind:'file',title:'one.txt',path:'nested/one.txt',summary:'First',sizeBytes:4,modifiedAt:100,contentIndexEligible:true}]},
      {id:'two',kind:'file',title:'two.txt',path:'two.txt',summary:'Second',sizeBytes:8,modifiedAt:101,contentIndexEligible:true}]};
  const state=await service.saveTree(accountId,tree,{mapId,sourceStatus:'ready'});
  map=state.maps.find(row=>row.id===mapId)!;
});
afterEach(async()=>{await database.delete();localStorage.clear();});

describe('read-only durable hydration equivalence',()=>{
  it('recognizes persistence-normalized IDs and write metadata without changing any durable bytes',async()=>{
    const before=await database.context_maps.get(mapId);
    const beforeEntities=await database.context_entities.toArray();
    const membership=await currentMembershipDigest(scope,map);
    expect(map.tree.nodes[0]!.id).not.toBe(tree.nodes[0]!.id);
    expect(map.tree.nodes[0]!.createdAt).toBeDefined();
    expect(await service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt)).toBe(true);
    expect(await service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt)).toBe(true);
    expect(await database.context_maps.get(mapId)).toEqual(before);
    expect(await database.context_entities.toArray()).toEqual(beforeEntities);
    expect(await currentMembershipDigest(scope,(await service.loadMap(accountId,scope.projectId,mapId))!)).toBe(membership);
  });

  it.each(['add','remove','content-metadata','size','summary','title','path','node-id','topology','missing-source-time','missing-source-size','index-revision','root'] as const)(
    'does not suppress a genuine %s change',async(change)=>{
      const next=structuredClone(tree);
      const file=next.nodes[0]!.children![0]!;
      if(change==='add'){next.nodes.push({id:'three',kind:'file',title:'three.txt',path:'three.txt',summary:'Third',sizeBytes:1,modifiedAt:100});next.fileCount++;next.totalBytes++;}
      if(change==='remove'){next.nodes.pop();next.fileCount--;next.totalBytes-=8;}
      if(change==='content-metadata')file.modifiedAt!++;
      if(change==='size'){file.sizeBytes!++;next.totalBytes++;}
      if(change==='summary')file.summary='Changed source summary';
      if(change==='title')file.title='Changed title';
      if(change==='path')file.path='nested/renamed.txt';
      if(change==='node-id')file.id='replacement-id';
      if(change==='topology'){next.nodes.push(file);next.nodes[0]!.children=[];}
      if(change==='missing-source-time')delete file.modifiedAt;
      if(change==='missing-source-size')delete file.sizeBytes;
      if(change==='index-revision')next.generatedAt++;
      if(change==='root')next.rootDir='C:/different';
      const before=await database.context_maps.get(mapId);
      expect(await service.hasEquivalentTree(accountId,next,mapId,map.updatedAt)).toBe(false);
      expect(await database.context_maps.get(mapId)).toEqual(before);
      const saved=await service.saveTree(accountId,next,{mapId,requireExisting:true,expectedUpdatedAt:map.updatedAt,select:false});
      expect((await database.context_maps.get(mapId))!.knowledgeRevision).toBe(before!.knowledgeRevision+1);
      expect(await currentMembershipDigest(scope,saved.maps.find(row=>row.id===mapId)!)).not.toBe(await currentMembershipDigest(scope,map));
    },
  );

  it('compares unknown source timestamps exactly rather than confusing them with persistence clocks',async()=>{
    const unknown=structuredClone(tree);delete unknown.nodes[0]!.children![0]!.modifiedAt;
    const saved=await service.saveTree(accountId,unknown,{mapId,requireExisting:true,expectedUpdatedAt:map.updatedAt,select:false});
    const current=saved.maps.find(row=>row.id===mapId)!;
    expect(current.tree.nodes[0]!.children![0]!.modifiedAt).toBeDefined();
    expect(await service.hasEquivalentTree(accountId,unknown,mapId,current.updatedAt)).toBe(true);
    const known=structuredClone(unknown);known.nodes[0]!.children![0]!.modifiedAt=current.updatedAt;
    expect(await service.hasEquivalentTree(accountId,known,mapId,current.updatedAt)).toBe(false);
  });

  it('preserves ownership, missing-map, stale revision, and abort refusals',async()=>{
    await expect(service.hasEquivalentTree('other-account',tree,mapId,map.updatedAt)).rejects.toThrow('map_missing');
    await expect(service.hasEquivalentTree(accountId,{...tree,projectId:'other-project'},mapId,map.updatedAt)).rejects.toThrow('map_missing');
    await expect(service.hasEquivalentTree(accountId,tree,'missing-map',map.updatedAt)).rejects.toThrow('map_missing');
    await expect(service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt-1)).rejects.toThrow('map_changed');
    const controller=new AbortController();controller.abort();
    await expect(service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt,controller.signal)).rejects.toThrow();
    await service.deleteMap(accountId,scope.projectId,mapId);
    await expect(service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt)).rejects.toThrow('map_missing');
  });
});


it('refuses cancellation after the durable map read without altering the graph',async()=>{
  const controller=new AbortController();
  const get=database.context_maps.get.bind(database.context_maps);
  const before=await get(mapId);
  vi.spyOn(database.context_maps,'get').mockImplementation((...args: Parameters<typeof database.context_maps.get>) =>
    get(...args).then(row => { controller.abort(); return row; }),
  );
  await expect(service.hasEquivalentTree(accountId,tree,mapId,map.updatedAt,controller.signal)).rejects.toThrow();
  expect(await get(mapId)).toEqual(before);
});

it('never treats a replacement local-file scope as equivalent',async()=>{
  const fileScope={version:1 as const,rootDir:'C:/single',filePath:'C:/single/selected.txt'};
  const single:ProjectContextTree={...tree,rootDir:fileScope.rootDir,sourceType:'local_file',localFileScope:fileScope,fileCount:1,totalBytes:4,
    nodes:[{id:'selected',kind:'file',title:'selected.txt',path:'selected.txt',summary:'',sizeBytes:4,modifiedAt:100}]};
  const state=await service.saveTree(accountId,single,{mapId:'single-map',sourceStatus:'ready',source:{kind:'local_file',label:'selected.txt',localFileScope:fileScope}});
  const current=state.maps.find(row=>row.id==='single-map')!;
  expect(await service.hasEquivalentTree(accountId,single,current.id,current.updatedAt)).toBe(true);
  const replacement={...single,localFileScope:{...fileScope,filePath:'C:/single/other.txt'}};
  expect(await service.hasEquivalentTree(accountId,replacement,current.id,current.updatedAt)).toBe(false);
});
