import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readdir,realpath,rename,rmdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// Independently observed R14 source-bound DLL inventory. Refresh these pins
// through reviewed build/toolchain evidence when changing ORT or MSVC.
const PINS=[
  {
    "name": "DirectML.dll",
    "bytes": 18527776,
    "sha256": "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
    "origin": "cargo-output"
  },
  {
    "name": "concrt140.dll",
    "bytes": 374200,
    "sha256": "54716f0738af891f283d213b5c8d11b25896bb8ee3097d301eae718560cf974e",
    "origin": "msvc-redist"
  },
  {
    "name": "msvcp140.dll",
    "bytes": 643512,
    "sha256": "7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca",
    "origin": "msvc-redist"
  },
  {
    "name": "msvcp140_1.dll",
    "bytes": 35768,
    "sha256": "206c931bf90fdad8816de3b5e2ef80b2bcaa9406c89ecc05fe6fddffe251e982",
    "origin": "msvc-redist"
  },
  {
    "name": "msvcp140_2.dll",
    "bytes": 274872,
    "sha256": "d50d7883f20d1dc6191768d3746f52dd9cac89c346ffaed5be1f110c2f34a838",
    "origin": "msvc-redist"
  },
  {
    "name": "msvcp140_atomic_wait.dll",
    "bytes": 57792,
    "sha256": "3d0cbfaa1bf3eecf5a3f4491d2960ee803cb994f30292c6adc4a07c498f60e2b",
    "origin": "msvc-redist"
  },
  {
    "name": "msvcp140_codecvt_ids.dll",
    "bytes": 31160,
    "sha256": "8a65c7596ef2e6938731f5a1058e7e40145b6d97967cc649231a076b9a608d78",
    "origin": "msvc-redist"
  },
  {
    "name": "vccorlib140.dll",
    "bytes": 350648,
    "sha256": "09f93d5ff96ae09767f3e1af3cdd43a5a58f2598654fc63089429bb6f9f4737f",
    "origin": "msvc-redist"
  },
  {
    "name": "vcruntime140.dll",
    "bytes": 178616,
    "sha256": "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7",
    "origin": "msvc-redist"
  },
  {
    "name": "vcruntime140_1.dll",
    "bytes": 50112,
    "sha256": "a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e",
    "origin": "msvc-redist"
  },
  {
    "name": "vcruntime140_threads.dll",
    "bytes": 38840,
    "sha256": "40f39e8cee5f5a531b4010e18b807e8fe265b908dc58f959ecb7ebc6ea6cb11a",
    "origin": "msvc-redist"
  }
];
const HELPER_SHA='c6468a12f492821c1b27292a1e2ecc763accb472a9702464eac8755e771e1038';
const ORT_ARCHIVE='b685bfc8d336e0ba95c066a7a982c03aa6dedd528a492eb99ca4ccb7f3af9e7a';
const CRT_VERSION='14.51.36231';
const digest=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file,{highWaterMark:65536}))h.update(b);return h.digest('hex');};
const within=(root,file)=>{const r=path.relative(root,file);assert(r&&!r.startsWith('..')&&!path.isAbsolute(r),'Path outside approved root');return file;};
const capture=(command,args)=>execFileSync(command,args,{encoding:'utf8',windowsHide:true,shell:false,maxBuffer:16*1024**2});
async function unlinkedDirectory(directory){const s=await lstat(directory);assert(s.isDirectory()&&!s.isSymbolicLink(),'Unlinked directory required');assert.equal(await realpath(directory),path.resolve(directory),'Reparse directory refused');}
async function exclusiveJson(file,data){await writeFile(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});}
export function selectRequiredDlls(dependencies){
  const wanted=new Set(),queue=['jarvis.exe'];
  while(queue.length){const module=queue.shift();for(const edge of dependencies){if(edge.module===module&&edge.kind==='packaged'&&!wanted.has(edge.imported)){wanted.add(edge.imported);queue.push(edge.imported);}}}
  assert(wanted.has('directml.dll')&&wanted.has('msvcp140.dll')&&wanted.has('msvcp140_1.dll'),'Expected native dependency contract changed');return wanted;
}
export async function prepareWindowsRuntimeDlls(){
  assert(process.platform==='win32'&&process.arch==='x64','Windows x64 DLL packaging only');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),tauri=path.join(root,'app/src-tauri');
  const triple=process.env.TAURI_ENV_TARGET_TRIPLE??'x86_64-pc-windows-msvc';assert.equal(triple,'x86_64-pc-windows-msvc');
  const profile=process.env.TAURI_ENV_DEBUG==='true'?'debug':'release';
  if(process.env.CARGO_TARGET_DIR)assert(path.isAbsolute(process.env.CARGO_TARGET_DIR),'Absolute Cargo target directory required');
  const targetRoot=path.resolve(process.env.CARGO_TARGET_DIR??path.join(tauri,'target'));
  const candidates=[];for(const directory of [path.join(targetRoot,profile),path.join(targetRoot,triple,profile)]){
    const exe=path.join(directory,'jarvis.exe'),s=await lstat(exe).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(s){assert(s.isFile()&&!s.isSymbolicLink());candidates.push(directory);}
  }
  assert.equal(candidates.length,1,'Exactly one current Cargo executable required; use isolated build outputs');
  const target=candidates[0],exe=path.join(target,'jarvis.exe'),helper=path.join(root,'scripts/native-windows-qa.mjs');
  assert.equal(await digest(helper),HELPER_SHA,'Reviewed shared DLL implementation changed');const qa=await import(pathToFileURL(helper));await qa.inspectPeImage(exe);
  const vswhere=path.join(process.env['ProgramFiles(x86)'],'Microsoft Visual Studio/Installer/vswhere.exe');
  const vs=capture(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath']).trim();assert(vs&&path.isAbsolute(vs)&&!/[\r\n]/u.test(vs));
  const redist=path.join(vs,'VC/Redist/MSVC',CRT_VERSION,'x64/Microsoft.VC145.CRT');
  try { await unlinkedDirectory(redist); } catch (cause) {
    throw new Error(`Reviewed MSVC ${CRT_VERSION} x64 redistribution unavailable. Future toolchain versions require an explicit reviewed DLL pin update; no automatic CRT fallback is permitted.`,{cause});
  }
  const toolRoots=(await readdir(path.join(vs,'VC/Tools/MSVC'))).filter(n=>/^14\.51\.\d+$/u.test(n)).sort().reverse();assert(toolRoots.length,'Pinned MSVC tool family unavailable');
  const dumpbin=path.join(vs,'VC/Tools/MSVC',toolRoots[0],'bin/Hostx64/x64/dumpbin.exe');
  const sourceSHA=capture('git',['-C',root,'rev-parse','HEAD']).trim(),exeSHA=await digest(exe);
  const evidence=path.join(root,'work/windows-runtime-dlls',randomUUID());await mkdir(evidence,{recursive:true});
  const inventory=await qa.materializeDlls(target,path.join(evidence,'materialized'),{sourceSHA,executableSHA256:exeSHA,msvcRedistRoot:redist});
  for(const file of inventory.files){const pin=PINS.find(p=>p.name.toLowerCase()===file.name.toLowerCase());assert(pin,'Unreviewed DLL input');assert.equal(file.bytes,pin.bytes);assert.equal(file.sha256,pin.sha256);assert.equal(file.origin,pin.origin);
    if(file.name.toLowerCase()==='directml.dll')assert(file.resolvedPath.replaceAll('\\','/').includes('/ort-cache/dfbin/'+triple+'/'+ORT_ARCHIVE+'/'),'DirectML must originate in this build pinned ORT archive');
  }
  let reports='';for(const file of [exe,...inventory.files.map(f=>path.join(inventory.directory,f.name))]){reports+=capture(dumpbin,['/DEPENDENTS',file])+'\n';assert(reports.length<=16*1024**2,'Dependency report bound');}
  await writeFile(path.join(evidence,'dll-dependencies.txt'),reports,{flag:'wx'});
  const modules=qa.parseDllReports(reports),dependencies=qa.verifyDllImports(modules,inventory),required=selectRequiredDlls(dependencies);
  const selected={...inventory,files:inventory.files.filter(f=>required.has(f.name.toLowerCase()))};
  qa.verifyDllImports(modules.filter(m=>m.name==='jarvis.exe'||required.has(m.name)),selected);
  assert.equal(await digest(exe),exeSHA,'Executable changed during DLL staging');
  const deployment=path.join(evidence,'deployment');await mkdir(deployment);
  const {copyFile}=await import('node:fs/promises');const {constants}=await import('node:fs');
  for(const file of selected.files){await copyFile(path.join(inventory.directory,file.name),path.join(deployment,file.name),constants.COPYFILE_EXCL);assert.equal(await digest(path.join(deployment,file.name)),file.sha256);}
  await exclusiveJson(path.join(evidence,'dll-inventory.json'),selected);await exclusiveJson(path.join(evidence,'dll-closure.json'),{dependencies:qa.verifyDllImports(modules.filter(m=>m.name==='jarvis.exe'||required.has(m.name)),selected),sourceSHA,executableSHA256:exeSHA,helperSHA256:HELPER_SHA,ortArchiveSHA256:ORT_ARCHIVE,msvcRedistVersion:CRT_VERSION,dumpbinSHA256:await digest(dumpbin),compiledByHook:false});
  const resources=path.join(tauri,'resources');await unlinkedDirectory(resources);const lock=path.join(resources,'.windows-runtime-dlls.lock');await mkdir(lock);
  const destination=within(resources,path.join(resources,'windows-runtime-dlls'));let previous=null;
  try{
    const exists=await lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(exists){await unlinkedDirectory(destination);for(const name of await readdir(destination)){const pin=PINS.find(f=>f.name===name);assert(pin,'Unowned DLL staging content');const file=path.join(destination,name),s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await digest(file),pin.sha256,'Existing DLL staging changed; preserve and investigate');}previous=path.join(evidence,'previous-deployment');await rename(destination,previous);}
    try{await rename(deployment,destination);}catch(error){if(previous)await rename(previous,destination);throw error;}
    await exclusiveJson(path.join(evidence,'deployment.json'),{destination,previous,sourceSHA,executableSHA256:exeSHA,files:selected.files.map(({name,bytes,sha256})=>({name,bytes,sha256})),installerExecuted:false});
  }finally{await rmdir(lock);}
  return {sourceSHA,executableSHA256:exeSHA,dlls:selected.files.length,evidence};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareWindowsRuntimeDlls()));
