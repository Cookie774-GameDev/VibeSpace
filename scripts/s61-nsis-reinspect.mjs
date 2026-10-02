import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,realpath,statfs,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const EXPECTED=Object.freeze({
  artifactId:11233764188,runId:37017376631,jobId:110871795273,repositoryId:1256753917,
  repository:'Cookie774-GameDev/VibeSpace',artifactName:'unsigned-nsis-diagnostics-37017376631-1',
  sourceSHA:'4008ea032e7625db77b9fb3c250b2b50c2fe4788',sourceTree:'af57b11f40cd13e87e14e393f7bea2b8d90ce344',
  archiveBytes:411344590,archiveSHA256:'59fe079dd0f15f61501b4526d5d6eaa1a9fe9be1a04fe75254a2713833314a8c',
  restoredSHA256:'444c4034250e26b1e1a21dc812e8e7aee1f54bfb38f6032ffdc966af461b134a',
  extractedSHA256:'4090a87b6ba2afa249f065fcd16ec2c9e079aa12eb693219250b95cb38a6c6c0',
  helperSHA256:'c6468a12f492821c1b27292a1e2ecc763accb472a9702464eac8755e771e1038',
  cargoLockSHA256:'a9b5c74ccc80b3deae6954d19b1ce6dcc9e2d980a194a465542d477bb80a1551',
  windowsConfigSHA256:'2c6209c5daefe31f25eb23b40c45601d896accb2066dd338efae1f8a624d6790',
  connectorSHA256:'3ef1b27c5fab49c1fcfda65cac522d4061b7557a884f5c811dfaee76ebbfe9af',
  sevenZipArchiveSHA256:'0859c524b8a63551848f0c246abddcb1d0b7b656b0fbfe879f8d85e61a9e6edd',
  sevenZipExeSHA256:'6ee3c0ed0b27663c1b948ae85a7c0bb073aed1498983182f3f0df1f6a8c30b2f',
  sevenZipDllSHA256:'65e4c1f855f9ef6e8f0f5df8e3f27d9eb5f07311408639da0a1ca0b8f4871b0d',
  bundlerSourceBlob:'ab0a45032f931af32b03c08ec5404c5cfe5c4891',
});
const CHUNK=64*1024,MAX_METADATA=8*1024*1024,MAX_CAPTURE=16*1024*1024,MIN_DISK=20*1024**3;
const UNK=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),NSS=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const sha256=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file,{highWaterMark:CHUNK}))h.update(b);return h.digest('hex');};
const save=(dir,name,value)=>writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
async function regular(file){const s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink(),'Regular unlinked input required');return s;}
async function smallJson(file){const s=await regular(file);assert(s.size<=MAX_METADATA,'Metadata exceeds bound');return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/u,''));}

export function assertArtifactMetadata(input){
  const a=input.artifact??input;
  assert.equal(a.id,EXPECTED.artifactId);assert.equal(a.name,EXPECTED.artifactName);assert.equal(a.expired,false);
  assert.equal(a.size_in_bytes,EXPECTED.archiveBytes);assert.equal(a.digest,'sha256:'+EXPECTED.archiveSHA256);
  assert.equal(a.workflow_run?.id,EXPECTED.runId);assert.equal(a.workflow_run?.head_sha,EXPECTED.sourceSHA);
  assert.equal(a.workflow_run?.repository_id,EXPECTED.repositoryId);
  assert.equal(a.workflow_run?.head_repository_id,EXPECTED.repositoryId);
  return {id:a.id,name:a.name,bytes:a.size_in_bytes,digest:a.digest,runId:a.workflow_run.id,sourceSHA:a.workflow_run.head_sha,repositoryId:a.workflow_run.repository_id};
}
export function validateRelativePath(input){
  assert(typeof input==='string'&&input.length>0&&input.length<=2048,'Archive path required');
  const normalized=input.replaceAll('\\','/').replace(/\/$/u,'');
  assert(normalized&&!normalized.startsWith('/')&&!normalized.includes(':')&&!/[\x00-\x1f]/u.test(normalized),'Absolute/ADS/control path');
  for(const segment of normalized.split('/')){
    assert(segment&&segment!=='.'&&segment!=='..'&&!/[ .]$/u.test(segment),'Path traversal/Windows alias');
    assert(!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment),'Windows device path');
  }
  return normalized;
}
export function parseArchiveListing(text){
  return text.trim().split(/\r?\n\s*\r?\n/u).filter(Boolean).map(block=>Object.fromEntries(block.split(/\r?\n/u).map(line=>{const at=line.indexOf(' = ');return at<0?[line,'']:[line.slice(0,at),line.slice(at+3)];})));
}
export function validatePackageIndex(rows){
  assert(Array.isArray(rows)&&rows.length>0&&rows.length<=100000,'Recorded package file array required');const seen=new Set();
  for(const row of rows){const key=validateRelativePath(row.path).toLowerCase();assert(!seen.has(key),'Recorded package collision');seen.add(key);assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0,'Recorded package size invalid');assert(/^[a-f0-9]{64}$/u.test(row.sha256),'Recorded package SHA invalid');}
  return rows;
}
export function validateArchiveEntries(entries,{maxFiles=100000,maxExpandedBytes=16*1024**3,packageIndex}={}){
  assert(entries.length>0&&entries.length<=maxFiles,'Archive entry count bound');let expandedBytes=0;const seen=new Set(),entrySizeBindings=[];
  const recorded=packageIndex?new Map(validatePackageIndex(packageIndex).map(row=>[validateRelativePath(row.path).toLowerCase(),row])):null;
  if(recorded)assert.equal(entries.length,recorded.size,'Archive count differs from authenticated package index');
  for(const e of entries){
    const name=validateRelativePath(e.Path);const key=name.toLowerCase();assert(!seen.has(key),'Archive case collision');seen.add(key);
    assert(!e['Symbolic Link']&&!e['Hard Link']&&!/L/u.test(e.Attributes??''),'Archive link');
    assert(e.Encrypted!=='+'&&e['Alternate Stream']!=='+'&&e['Anti']!=='+','Unsupported encrypted/stream/anti entry');
    const row=recorded?.get(key);if(recorded)assert(row,'Archive entry missing from authenticated package index');
    const indexedUninstaller=e.Size===''&&e.Path==='uninstall.exe'&&e.Solid==='+'&&e.Method==='LZMA:23'&&row;
    assert(indexedUninstaller||/^\d+$/u.test(e.Size??'0'),'Invalid archive size');
    const listedBytes=indexedUninstaller?null:Number(e.Size??0);assert(listedBytes===null||(Number.isSafeInteger(listedBytes)&&listedBytes>=0),'Invalid expanded size');
    const size=indexedUninstaller?row.bytes:Math.max(listedBytes,row?.bytes??0);
    if(row)entrySizeBindings.push({path:name,bytes:row.bytes,listedBytes,expansionBoundBytes:size,sha256:row.sha256,sizeSource:indexedUninstaller?'authenticated-original-index-generated-uninstaller':'maximum-of-7zip-and-authenticated-original-index'});
    expandedBytes+=size;assert(Number.isSafeInteger(expandedBytes)&&expandedBytes<=maxExpandedBytes,'Archive expansion bound');
  }
  return {entries:entries.length,expandedBytes,...(recorded?{authenticatedIndexMatched:true,entrySizeBindings}:{})};
}
async function walk(dir,base=dir,files=[]){
  for(const e of await readdir(dir,{withFileTypes:true})){
    const file=path.join(dir,e.name),s=await lstat(file);
    assert(!s.isSymbolicLink()&&(s.isDirectory()||s.isFile()),'Linked/special extracted entry');
    const rel=path.relative(await realpath(base),await realpath(file));assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'Extracted path escape');
    validateRelativePath(rel);if(s.isDirectory())await walk(file,base,files);else{files.push(file);assert(files.length<=100000,'Extracted file count bound');}
  }return files;
}
function capture(command,args){return execFileSync(command,args,{encoding:'utf8',windowsHide:true,shell:false,maxBuffer:MAX_CAPTURE});}
async function extract(tool,archive,destination,output,label,bounds){
  assert(!(await lstat(destination).catch(()=>null)),'Extraction directory must be new');
  const listing=capture(tool,['l','-slt','-ba',archive]);await writeFile(path.join(output,label+'-listing.txt'),listing,{flag:'wx'});
  const entries=parseArchiveListing(listing),summary=validateArchiveEntries(entries,bounds);await save(output,label+'-entries.json',entries);
  if(summary.authenticatedIndexMatched)await save(output,label+'-size-bounds.json',summary);
  const free=await statfs(path.dirname(destination));assert(Number(free.bavail)*Number(free.bsize)>=Math.max(MIN_DISK,summary.expandedBytes+1024**3),'Insufficient output disk');
  await mkdir(destination);capture(tool,['x','-y','-o'+destination,archive]);
  const files=await walk(destination),seen=new Set();for(const f of files){const rel=validateRelativePath(path.relative(destination,f));assert(!seen.has(rel.toLowerCase()),'Extracted case collision');seen.add(rel.toLowerCase());}
  return {files,summary,entries};
}
export async function findMarkerOffsets(file,token=NSS,maxCandidates=64){
  const offsets=[];let carry=Buffer.alloc(0),processed=0;
  for await(const chunk of createReadStream(file,{highWaterMark:CHUNK})){
    const b=carry.length?Buffer.concat([carry,chunk]):chunk;let at=0;
    while((at=b.indexOf(token,at))!==-1){offsets.push(processed+at);assert(offsets.length<=maxCandidates,'Marker candidate bound');at+=token.length;}
    const keep=Math.min(token.length-1,b.length),safe=b.length-keep;processed+=safe;carry=Buffer.from(b.subarray(safe));
  }return offsets;
}
export async function streamTokenReplacement(file,offset,from,to,{output}={}){
  assert(Number.isSafeInteger(offset)&&offset>=0);assert.equal(from.length,to.length);
  const h=createHash('sha256');let bytes=0,replacedBytes=0;const writer=output?await open(output,'wx'):null;
  try{
    for await(const chunk of createReadStream(file,{highWaterMark:CHUNK})){
      let b=chunk;const start=Math.max(offset,bytes),end=Math.min(offset+from.length,bytes+chunk.length);
      if(start<end){const localStart=start-bytes,partStart=start-offset,len=end-start;
        assert(chunk.subarray(localStart,localStart+len).equals(from.subarray(partStart,partStart+len)),'Marker bytes at requested offset differ');
        b=Buffer.from(chunk);to.copy(b,localStart,partStart,partStart+len);replacedBytes+=len;
      }
      h.update(b);if(writer){let at=0;while(at<b.length){const result=await writer.write(b,at,b.length-at);assert(result.bytesWritten>0,'Reference write made no progress');at+=result.bytesWritten;}}bytes+=chunk.length;
    }
    assert.equal(replacedBytes,from.length,'Incomplete marker substitution');return {sha256:h.digest('hex'),byteCount:bytes,markerOffset:offset};
  }finally{await writer?.close();}
}
export async function recoverReference(extracted,output,expectedRestoredSHA=EXPECTED.restoredSHA256,{maxCandidates=64,onCandidates}={}){
  const offsets=await findMarkerOffsets(extracted,NSS,maxCandidates);assert(offsets.length>0,'NSIS marker missing');
  const attempts=[],matches=[];
  for(const offset of offsets){const result=await streamTokenReplacement(extracted,offset,NSS,UNK);attempts.push(result);if(result.sha256===expectedRestoredSHA)matches.push(result);}
  await onCandidates?.({expectedRestoredSHA256:expectedRestoredSHA,candidates:attempts,matchingCandidates:matches.length});
  assert.equal(matches.length,1,'Exactly one inverse candidate must match independent built executable hash');
  const written=await streamTokenReplacement(extracted,matches[0].markerOffset,NSS,UNK,{output});
  assert.equal(written.sha256,expectedRestoredSHA,'Reconstructed reference hash changed');assert.equal(await sha256(output),expectedRestoredSHA,'Written reference bytes differ');return {...written,candidateCount:offsets.length,attempts,referenceRecovery:'reconstructed_from_packaged_bytes_against_independent_build_log_hash'};
}
export function isProductInput(name,nativeQaIsProduct=false){
  const test=/(?:^|\/)(?:__tests__|__snapshots__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/u.test(name);
  return !test&&(name.startsWith('app/')||name.startsWith('packages/')||name.startsWith('vendor/')||name.startsWith('resources/')||name.startsWith('docs/oss/')||name.startsWith('install/')||
    (name.startsWith('scripts/')&&name!=='scripts/s61-nsis-reinspect.mjs'&&(nativeQaIsProduct||name!=='scripts/native-windows-qa.mjs'))||
    ['package.json','package-lock.json','.gitmodules','.npmrc','.github/native-windows-qa/Cargo.lock'].includes(name));
}
function gitInputs(root){
  const raw=execFileSync('git',['-C',root,'ls-tree','-rz','--full-tree','HEAD'],{encoding:'utf8',maxBuffer:MAX_CAPTURE});
  const all=raw.split('\0').filter(Boolean).map(row=>{const tab=row.indexOf('\t');assert(tab>0);const [mode,type,sha]=row.slice(0,tab).split(' '),name=row.slice(tab+1);return {path:name,mode,type,sha};});
  const nativeQaIsProduct=all.some(row=>row.path==='scripts/prepare-windows-runtime-dlls.mjs');
  return all.filter(x=>isProductInput(x.path,nativeQaIsProduct)).sort((a,b)=>a.path.localeCompare(b.path));
}
export function assertMatchingProductInputs(original,verification){
  assert.equal(JSON.stringify(original),JSON.stringify(verification),'R15→verification product/native inputs changed; package reuse forbidden');
}
export function verifyOriginalJobLog(log){
  const clean=log.replace(/\x1b\[[0-9;]*m/gu,'');
  assert(clean.includes('QA_SOURCE_SHA: '+EXPECTED.sourceSHA),'Original source log missing');
  assert(clean.includes('AssertionError [ERR_ASSERTION]: Extracted executable differs from built release'),'Original first failure missing');
  assert(new RegExp("actual:\\s*'"+EXPECTED.extractedSHA256+"'").test(clean),'Independent actual executable hash missing');
  assert(new RegExp("expected:\\s*'"+EXPECTED.restoredSHA256+"'").test(clean),'Independent restored build hash missing');
  assert(clean.includes('Finished 1 bundle at:'),'Actual NSIS package completion missing');
}
export function assertOriginalCapacity(capacity){
  assert.equal(capacity.admitted,true,'Original compile admission not proven');
  assert(Number.isSafeInteger(capacity.freeRamMiB)&&capacity.freeRamMiB>=11264,'Original RAM admission not proven');
  assert(Number.isSafeInteger(capacity.freeCommitMiB)&&capacity.freeCommitMiB>=16384,'Original commit admission not proven');
  assert(Array.isArray(capacity.disks)&&capacity.disks.length>0,'Original disk record array required');
  const volumes=new Set();
  for(const disk of capacity.disks){
    assert(disk&&typeof disk==='object'&&!Array.isArray(disk),'Original disk record required');
    assert(typeof disk.volume==='string'&&/^[A-Z]:$/iu.test(disk.volume),'Original valid volume name required');
    const volume=disk.volume.toUpperCase();assert(!volumes.has(volume),'Original duplicate volume');volumes.add(volume);
    assert(Number.isSafeInteger(disk.freeBytes)&&disk.freeBytes>=MIN_DISK,'Original disk admission not proven');
  }
  assert.equal(capacity.estimatedPeakRamMiB,8192);assert.equal(capacity.estimatedPeakCommitMiB,12288);assert.equal(capacity.estimatesMeasured,false);
  return capacity;
}
async function uniqueBasename(files,name){const hits=files.filter(f=>path.basename(f).toLowerCase()===name.toLowerCase());assert.equal(hits.length,1,'Unique archive file required: '+name);return hits[0];}
async function originalPackageIndex(file){
  return validatePackageIndex(await smallJson(file));
}
export async function verifyRecordedFiles(files,base,rows){
  assert.equal(files.length,rows.length,'Extracted package file count differs from original');
  const expected=new Map(rows.map(r=>[r.path.toLowerCase(),r])),actual=[];
  for(const file of files){const rel=path.relative(base,file).replaceAll('\\','/'),e=expected.get(rel.toLowerCase());assert(e,'Unrecorded extracted payload');
    const bytes=(await regular(file)).size,digest=await sha256(file);assert.equal(bytes,e.bytes,'Recorded payload length mismatch');assert.equal(digest,e.sha256,'Recorded payload SHA mismatch');
    actual.push({path:rel,bytes,sha256:digest});
  }return actual;
}
export function assertConnectorManifest(manifest,runtimes){
  assert.deepEqual(Object.keys(manifest).sort(),['platform','runtimes','sha256','sourceHash','version'],'Connector manifest schema changed');
  assert.equal(manifest.version,1);assert.equal(manifest.platform,'win32-x64');assert.equal(manifest.sourceHash,EXPECTED.connectorSHA256);
  assert.match(manifest.sha256,/^[a-f0-9]{64}$/u,'Connector archive SHA required');assert.deepEqual(manifest.runtimes,runtimes,'Pinned connector runtime inputs changed');
  return manifest;
}
export function assertConnectorEntryEquivalence(original,fresh){
  validatePackageIndex(original);validatePackageIndex(fresh);
  assert.deepEqual(original,fresh,'Connector payload entries differ in path/length/full SHA');
}
async function connectorFileInventory(files,base){
  const result=[];
  for(const file of files)result.push({path:validateRelativePath(path.relative(base,file)),bytes:(await regular(file)).size,sha256:await sha256(file)});
  return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
async function proveConnectorResources(root,appDir,output,tool,preparation){
  const fresh=path.join(root,'app/src-tauri/resources/desktop-connector'),packaged=path.join(appDir,'resources/desktop-connector');
  const freshManifest=await smallJson(path.join(fresh,'manifest.json')),packagedManifest=await smallJson(path.join(packaged,'manifest.json'));
  await save(output,'connector-fresh-manifest.json',freshManifest);await save(output,'connector-packaged-manifest.json',packagedManifest);
  assertConnectorManifest(freshManifest,preparation.runtimes);assertConnectorManifest(packagedManifest,preparation.runtimes);
  const freshZip=path.join(fresh,'runtime.zip'),packagedZip=path.join(packaged,'runtime.zip');await regular(freshZip);await regular(packagedZip);
  const freshZipSHA=await sha256(freshZip),packagedZipSHA=await sha256(packagedZip);
  await save(output,'connector-container-binding.json',{sourceHash:EXPECTED.connectorSHA256,freshManifestSHA256:await sha256(path.join(fresh,'manifest.json')),packagedManifestSHA256:await sha256(path.join(packaged,'manifest.json')),freshZipSHA256:freshZipSHA,packagedZipSHA256:packagedZipSHA,pinnedRuntimeInputs:preparation.runtimes});
  assert.equal(freshZipSHA,freshManifest.sha256,'Fresh connector archive digest mismatch');assert.equal(packagedZipSHA,packagedManifest.sha256,'Packaged connector archive digest mismatch');
  const packagedRoot=path.join(output,'connector-packaged-payload'),freshRoot=path.join(output,'connector-fresh-payload');
  const packagedPayload=await extract(tool,packagedZip,packagedRoot,output,'connector-packaged');
  const freshPayload=await extract(tool,freshZip,freshRoot,output,'connector-fresh');
  const canonicalPaths=entries=>entries.map(entry=>({path:validateRelativePath(entry.Path),directory:entry.Folder==='+'||/^D(?:\s|$)/u.test(entry.Attributes??'')})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert.deepEqual(canonicalPaths(packagedPayload.entries),canonicalPaths(freshPayload.entries),'Connector inner archive paths/types differ');
  const originalEntries=await connectorFileInventory(packagedPayload.files,packagedRoot),freshEntries=await connectorFileInventory(freshPayload.files,freshRoot);
  await save(output,'connector-packaged-files.json',originalEntries);await save(output,'connector-fresh-files.json',freshEntries);
  assertConnectorEntryEquivalence(originalEntries,freshEntries);
  for(const relative of ['runtime/node.exe','runtime/python/python.exe','runtime/tunnel-client.exe','runtime/cloudflared.exe','gateway.mjs','supervisor.mjs','startup.mjs','startup.ps1','startup.vbs','setup/index.html']){
    const file=path.join(packagedRoot,...relative.split('/'));assert((await regular(file)).size>0,'Required connector runtime/source file empty');
  }
  await preparation.validatePlugin3Tree(path.join(packagedRoot,'plugin3'));await preparation.validatePlugin3Tree(path.join(freshRoot,'plugin3'));
  const proof={sourceHash:EXPECTED.connectorSHA256,pinnedRuntimeInputs:preparation.runtimes,manifestVersion:1,platform:'win32-x64',freshZipSHA256:freshZipSHA,packagedZipSHA256:packagedZipSHA,files:originalEntries.length,exactInnerPathLengthSHA256Equivalence:true,originalOuterPackageBindingRetained:true,containerBytesRewritten:false,archivedCodeExecuted:false,nativeRuntimeAcceptance:'UNVERIFIED'};
  await save(output,'connector-resource-equivalence.json',proof);return proof;
}
export function resolveResourceTargets(resources,candidates,base){
  assert(resources&&typeof resources==='object','Windows resources array or destination map required');
  const mapped=!Array.isArray(resources),declarations=mapped?Object.entries(resources):resources.map(pattern=>[pattern,null]),expected=new Map();
  assert(declarations.length>0,'Nonempty resource contract required');
  for(const [pattern,destination]of declarations){
    assert(typeof pattern==='string'&&pattern.length>0,'Resource source pattern required');
    if(mapped){assert(typeof destination==='string','Resource destination required');if(destination)validateRelativePath(destination);}
    const directory=mapped&&pattern.endsWith('/'),glob=pattern.includes('*');
    const re=new RegExp('^'+pattern.split(/(\*\*\/|\*\*|\*)/u).map(x=>x==='**/'?'(?:.*/)?':x==='**'?'.*':x==='*'?'[^/]*':x.replace(/[.+?^$\x7b\x7d()|[\]\\]/gu,'\\$&')).join('')+'$');
    const matched=candidates.filter(file=>{const rel=path.relative(base,file).replaceAll('\\','/');return directory?rel.startsWith(pattern):re.test(rel);});
    assert(matched.length,'Resource pattern matched nothing: '+pattern);
    for(const file of matched){const rel=path.relative(base,file).replaceAll('\\','/');let target;
      if(!mapped)target=rel.split('/').map(x=>x==='..'?'_up_':x).join('/');
      else if(directory)target=path.posix.join(destination,rel.slice(pattern.length));
      else if(glob||destination.endsWith('/')||destination==='')target=path.posix.join(destination,path.posix.basename(rel));
      else target=destination;
      target=validateRelativePath(target);assert(!expected.has(target.toLowerCase()),'Resource target collision');expected.set(target.toLowerCase(),{file,target});
    }
  }
  return expected;
}
export async function verifyResources(root,appDir,output,tool,preparation){
  const base=path.join(root,'app/src-tauri'),config=await smallJson(path.join(base,'tauri.windows.conf.json'));
  const candidates=[...await walk(path.join(base,'resources')),...await walk(path.join(root,'docs/oss'))];
  const expected=resolveResourceTargets(config.bundle.resources,candidates,base);
  const connectorProof=await proveConnectorResources(root,appDir,output,tool,preparation);
  const connectorPaths=new Set(['resources/desktop-connector/manifest.json','resources/desktop-connector/runtime.zip']);
  const rows=[];for(const {file,target}of expected.values()){
    const packaged=path.join(appDir,...target.split('/'));const sourceDigest=await sha256(file),digest=await sha256(packaged);
    if(!connectorPaths.has(target))assert.equal(digest,sourceDigest,'Missing/changed packaged resource: '+target);
    rows.push({path:target,bytes:(await regular(packaged)).size,sha256:digest,...(connectorPaths.has(target)?{sourceSHA256:sourceDigest,equivalenceProof:'connector-resource-equivalence.json',exactInnerPathLengthSHA256Equivalence:connectorProof.exactInnerPathLengthSHA256Equivalence}:{})});
  }
  const connector=await smallJson(path.join(appDir,'resources/desktop-connector/manifest.json'));
  assert.equal(connector.platform,'win32-x64');assert.equal(await sha256(path.join(appDir,'resources/desktop-connector/runtime.zip')),connector.sha256);
  await regular(path.join(appDir,'resources/siyuan-runtime/VIBESPACE_SIYUAN_READY.json'));await save(output,'resource-manifest.json',rows);return rows;
}
export async function runReinspection(config){
  const output=path.resolve(config.outputDir);assert(!(await lstat(output).catch(()=>null)),'Fresh proof output required');await mkdir(output);
  const saveHere=(name,data)=>save(output,name,data);
  try{
    assert(process.platform==='win32'&&process.env.GITHUB_ACTIONS==='true','Cloud Windows inspection only');
    for(const field of ['artifactZip','artifactMetadata','originalJobLog','sourceRoot','sevenZipArchive','sevenZipExecutable','dumpbin'])assert(typeof config[field]==='string'&&config[field],field+' required');
    const descriptor=assertArtifactMetadata(await smallJson(config.artifactMetadata));await saveHere('artifact-descriptor.json',descriptor);
    const zip=await regular(config.artifactZip);assert.equal(zip.size,EXPECTED.archiveBytes);assert.equal(await sha256(config.artifactZip),EXPECTED.archiveSHA256,'Raw artifact ZIP digest mismatch');
    await saveHere('raw-archive-verification.json',{...descriptor,sha256:EXPECTED.archiveSHA256,wholeZIPDigestVerified:true});
    const logFile=await regular(config.originalJobLog);assert(logFile.size<=4*1024*1024);verifyOriginalJobLog(await readFile(config.originalJobLog,'utf8'));
    await saveHere('independent-build-log.json',{jobId:EXPECTED.jobId,sha256:await sha256(config.originalJobLog),restoredSHA256:EXPECTED.restoredSHA256,extractedSHA256:EXPECTED.extractedSHA256,originalFailureRetained:true});
    const source=path.resolve(config.sourceRoot),verifier=path.resolve(config.verifierRoot??path.dirname(path.dirname(config.helperModule)));
    const head=capture('git',['-C',source,'rev-parse','HEAD']).trim(),tree=capture('git',['-C',source,'rev-parse','HEAD^{tree}']).trim();
    assert.equal(head,EXPECTED.sourceSHA);assert.equal(tree,EXPECTED.sourceTree);
    const verificationHead=capture('git',['-C',verifier,'rev-parse','HEAD']).trim(),productInputs=gitInputs(source);
    assertMatchingProductInputs(productInputs,gitInputs(verifier));await saveHere('product-inputs.json',{sourceSHA:head,sourceTree:tree,verificationSHA:verificationHead,inputs:productInputs,reuseEligibility:'MATCH'});
    assert.equal(await sha256(path.join(source,'.github/native-windows-qa/Cargo.lock')),EXPECTED.cargoLockSHA256);
    assert.equal(await sha256(path.join(source,'app/src-tauri/Cargo.lock')),EXPECTED.cargoLockSHA256);
    assert.equal(await sha256(path.join(source,'app/src-tauri/tauri.windows.conf.json')),EXPECTED.windowsConfigSHA256);
    const connectorPreparation=await import(pathToFileURL(path.join(source,'scripts/prepare-desktop-connector.mjs')));
    assert.equal(await connectorPreparation.fingerprint(),EXPECTED.connectorSHA256,'Connector source fingerprint differs');
    const helper=path.resolve(config.helperModule??path.join(verifier,'scripts/native-windows-qa.mjs'));await regular(helper);
    assert.equal(await sha256(helper),EXPECTED.helperSHA256,'Reviewed helper changed');
    const relativeHelper=path.relative(await realpath(verifier),await realpath(helper));assert(relativeHelper&&!relativeHelper.startsWith('..')&&!path.isAbsolute(relativeHelper),'Helper outside verifier checkout');
    const qa=await import(pathToFileURL(helper));assert(typeof qa.inspectTauriNsisExecutableBinding==='function','Reviewed streaming helper missing');
    await regular(config.sevenZipExecutable);await regular(config.sevenZipArchive);
    assert.equal(await sha256(config.sevenZipArchive),EXPECTED.sevenZipArchiveSHA256,'Pinned7zip archive changed');
    assert.equal(await sha256(config.sevenZipExecutable),EXPECTED.sevenZipExeSHA256,'Pinned7zip executable changed');
    const sevenDll=path.join(path.dirname(config.sevenZipExecutable),'7z.dll');await regular(sevenDll);assert.equal(await sha256(sevenDll),EXPECTED.sevenZipDllSHA256,'Pinned7zip DLL changed');
    await regular(config.dumpbin);await saveHere('verification-tools.json',{helperSHA256:EXPECTED.helperSHA256,sevenZip:'26.03',sevenZipArchiveSHA256:EXPECTED.sevenZipArchiveSHA256,sevenZipExecutableSHA256:EXPECTED.sevenZipExeSHA256,sevenZipDLLSHA256:EXPECTED.sevenZipDllSHA256,dumpbinSHA256:await sha256(config.dumpbin),runnerImage:process.env.ImageVersion??null});
    const archiveRoot=path.join(output,'artifact-files'),archive=await extract(config.sevenZipExecutable,config.artifactZip,archiveRoot,output,'artifact',{maxFiles:4096,maxExpandedBytes:2*1024**3});
    const installers=archive.files.filter(f=>f.toLowerCase().endsWith('.exe'));assert.equal(installers.length,1,'Exactly one archived installer required');const installer=installers[0];assert.equal(path.basename(installer),'VibeSpace_1.5.0_x64-setup.exe');
    const tools=await smallJson(await uniqueBasename(archive.files,'tool-manifest.json'));
    assert.equal(tools.cli,'2.11.2');assert.equal(tools.sevenZip,'26.03');assert.equal(tools.sevenZipArchiveSHA256.toLowerCase(),EXPECTED.sevenZipArchiveSHA256);
    assert.equal(tools.sevenZipExeSHA256.toLowerCase(),EXPECTED.sevenZipExeSHA256);assert.equal(tools.sevenZipDllSHA256.toLowerCase(),EXPECTED.sevenZipDllSHA256);
    assert.equal(tools.nsisArchiveSHA1.toLowerCase(),'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d');assert.equal(tools.nsisPluginSHA1.toLowerCase(),'75197fee3c6a814fe035788d1c34ead39349b860');assert.equal(tools.nsisVersion,'v3.11');
    await saveHere('original-tools.json',tools);
    const capacity=await smallJson(await uniqueBasename(archive.files,'capacity-before-build.json'));
    assertOriginalCapacity(capacity);
    await saveHere('original-capacity-before-build.json',capacity);
    const originalRows=await originalPackageIndex(await uniqueBasename(archive.files,'package-files.json'));
    const payloadRoot=path.join(output,'nsis-payload'),payload=await extract(config.sevenZipExecutable,installer,payloadRoot,output,'nsis',{packageIndex:originalRows});
    await saveHere('package-files.json',await verifyRecordedFiles(payload.files,payloadRoot,originalRows));
    const exe=await uniqueBasename(payload.files,'jarvis.exe');assert.equal(await sha256(exe),EXPECTED.extractedSHA256,'Actual archived NSIS exe identity mismatch');
    const reference=path.join(output,'restored-reference.exe'),recovery=await recoverReference(exe,reference,EXPECTED.restoredSHA256,{onCandidates:data=>saveHere('reference-candidates.json',data)});
    await saveHere('reference-recovery.json',recovery);
    const binding=await qa.inspectTauriNsisExecutableBinding(reference,exe,{tauriCliVersion:'2.11.2',tauriBundlerSourceBlob:EXPECTED.bundlerSourceBlob,bundleKind:'nsis'});
    await saveHere('executable-binding.json',binding);assert.equal(binding.restoredExecutableSHA256,EXPECTED.restoredSHA256);assert.equal(binding.expectedNsisExecutableSHA256,EXPECTED.extractedSHA256);assert.equal(binding.extractedExecutableSHA256,binding.expectedNsisExecutableSHA256,'Exact pinned forward transformation mismatch');
    const appDir=path.dirname(exe),pe=await qa.inspectPeImage(exe);await saveHere('exe-pe-manifest.json',{...pe,sha256:EXPECTED.extractedSHA256,sourceSHA:head});
    const dlls=(await readdir(appDir)).filter(n=>n.toLowerCase().endsWith('.dll')),inventory={sourceSHA:head,executableSHA256:EXPECTED.extractedSHA256,files:[]};
    for(const name of dlls){await regular(path.join(appDir,name));inventory.files.push({name,...await qa.inspectPeImage(path.join(appDir,name),true),sha256:await sha256(path.join(appDir,name))});}
    await saveHere('dll-inventory.json',inventory);let reports='';
    for(const file of [exe,...dlls.map(n=>path.join(appDir,n))]){reports+=capture(config.dumpbin,['/DEPENDENTS',file])+'\n';assert(reports.length<=MAX_CAPTURE,'DLL report bound');}
    await writeFile(path.join(output,'dll-dependencies.txt'),reports,{flag:'wx'});
    const resources=await verifyResources(source,appDir,output,config.sevenZipExecutable,connectorPreparation),closure=qa.verifyDllImports(qa.parseDllReports(reports),inventory);await saveHere('dll-closure.json',closure);
    const qaConfig=path.join(output,'s61-unsigned-nsis.generated.json');await writeFile(qaConfig,'{"bundle":{"createUpdaterArtifacts":false}}\r\n',{flag:'wx'});
    if(config.qaConfig)assert.deepEqual(await smallJson(config.qaConfig),{bundle:{createUpdaterArtifacts:false}},'Recreated QA configuration differs');
    const proof={artifact:descriptor,installer:{file:path.basename(installer),bytes:(await regular(installer)).size,sha256:await sha256(installer)},sourceSHA:head,sourceTree:tree,verificationSHA:verificationHead,helperSHA256:EXPECTED.helperSHA256,referenceRecovery:recovery.referenceRecovery,executable:binding,resources:resources.length,dlls:dlls.length,cargoLockSHA256:EXPECTED.cargoLockSHA256,windowsConfigSHA256:EXPECTED.windowsConfigSHA256,qaConfigSHA256:await sha256(qaConfig),qaConfigRecreated:true,staticPackageProof:'PASS',installerExecuted:false,compiled:false,nativeAcceptance:'UNVERIFIED',cleanWindowsVM:'UNVERIFIED'};
    await saveHere('package-proof.json',proof);return proof;
  }catch(error){await saveHere('first-failure.json',{message:String(error.message).replace(/https?:\/\/\S+/gu,'[URL redacted]'),stack:String(error.stack).replace(/https?:\/\/\S+/gu,'[URL redacted]'),staticPackageProof:'FAIL',installerExecuted:false,compiled:false,nativeAcceptance:'UNVERIFIED',cleanWindowsVM:'UNVERIFIED'});throw error;}
}
async function main(){
  let args=process.argv.slice(2);if(args[0]==='run')args=args.slice(1);assert.equal(args.length,2,'Expected --config trusted-config.json');assert.equal(args[0],'--config');
  const result=await runReinspection(await smallJson(args[1]));console.log(JSON.stringify({staticPackageProof:result.staticPackageProof,installerExecuted:false,compiled:false,nativeAcceptance:'UNVERIFIED',cleanWindowsVM:'UNVERIFIED'}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
