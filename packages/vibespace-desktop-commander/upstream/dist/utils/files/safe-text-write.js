// Plugin 2: guarded UTF-8 text transactions. No mutation is automatically replayed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const context = new AsyncLocalStorage();
const queues = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const version = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const conflict = () => Object.assign(new Error('Write conflict: file changed; re-read and review. No write was applied.'),{code:'WRITE_CONFLICT'});
async function canonical(file) {
  try { return await fs.realpath(file); }
  catch (e) { if(e.code!=='ENOENT')throw e;return path.join(await fs.realpath(path.dirname(path.resolve(file))),path.basename(file)); }
}
async function inspect(file) {
  try { const s=await fs.stat(file);if(!s.isFile())throw new Error('Text target must be a regular file');if(s.nlink>1)throw new Error('Refusing staged replacement of a hard-linked file');if(s.size>MAX_TEXT_BYTES)throw new Error('Text transaction exceeds 64 MiB; use a reviewed streaming local script');return s; }
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function readTextSnapshot(file,{signal}={}) {
  signal?.throwIfAborted();
  const before=await inspect(file);
  if(!before)return {text:'',sha256:null,version:null,mode:0o600,exists:false};
  const bytes=await fs.readFile(file,{signal});
  const after=await inspect(file);
  if(!after || version(before)!==version(after))throw conflict();
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  return {text,sha256:hash(bytes),version:version(after),mode:before.mode&0o777,exists:true};
}
async function acquireDiskLock(file,signal) {
  const key=process.platform==='win32'?file.toLowerCase():file;
  const dir=path.join(path.dirname(file),`.dc-write-${hash(key).slice(0,20)}.lock`);
  const owner=path.join(dir,'owner.json'),started=Date.now(),token=randomUUID();
  while(true){
    signal?.throwIfAborted();
    try{
      await fs.mkdir(dir,{mode:0o700});
      try{await fs.writeFile(owner,JSON.stringify({pid:process.pid,token,at:Date.now()}),{flag:'wx',mode:0o600});}
      catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
      return async()=>{try{const o=JSON.parse(await fs.readFile(owner,'utf8'));if(o.token===token)await fs.rm(dir,{recursive:true,force:true});}catch(e){if(e.code!=='ENOENT')throw e;}};
    }catch(e){if(e.code!=='EEXIST')throw e;}
    // Reclaim only locks with a demonstrably dead owner. Never steal a live lock.
    try{
      const o=JSON.parse(await fs.readFile(owner,'utf8'));
      if(Number.isInteger(o.pid)&&o.pid>0&&Date.now()-o.at>250){
        let dead=false;try{process.kill(o.pid,0);}catch(e){dead=e.code==='ESRCH';}
        if(dead){const tomb=dir+'.orphan-'+token;await fs.rename(dir,tomb);
          try{const stage=JSON.parse(await fs.readFile(path.join(tomb,'stage.json'),'utf8'));if(/^\.dc-stage-[a-f0-9-]+\.tmp$/.test(stage.name))await fs.rm(path.join(path.dirname(file),stage.name),{force:true});}catch{}
          await fs.rm(tomb,{recursive:true,force:true});continue;}
      }
    }catch(e){if(!['ENOENT','EEXIST','EPERM'].includes(e.code)&&!(e instanceof SyntaxError))throw e;}
    if(Date.now()-started>15000)throw new Error('File is locked by another writer; no changes applied. Inspect the lock owner before retrying.');
    await sleep(40,undefined,{signal});
  }
}
export async function withFileLock(file,operation,{signal}={}) {
  const target=await canonical(file),key=process.platform==='win32'?target.toLowerCase():target;
  if(context.getStore()?.has(key))return operation(target);
  const previous=queues.get(key)||Promise.resolve();let releaseQueue;
  const gate=new Promise(r=>{releaseQueue=r;});const tail=previous.catch(()=>{}).then(()=>gate);queues.set(key,tail);
  try{
    await previous.catch(()=>{});signal?.throwIfAborted();
    const release=await acquireDiskLock(target,signal);
    try{return await context.run(new Set([...(context.getStore()||[]),key]),()=>operation(target));}
    finally{await release();}
  }finally{releaseQueue();if(queues.get(key)===tail)queues.delete(key);}
}
export async function writeText(file,content,mode='rewrite',options={}) {
  if(typeof content!=='string')throw new TypeError('Text write requires a string');
  if(!['rewrite','append'].includes(mode))throw new TypeError('Unknown text write mode');
  return withFileLock(file,async target=>{
    const before=await readTextSnapshot(target,options);
    if(options.expectedSha256!==undefined&&options.expectedSha256!==before.sha256)throw conflict();
    const next=mode==='append'?before.text+content:content;
    if(Buffer.byteLength(next)>MAX_TEXT_BYTES)throw new RangeError('Text transaction exceeds 64 MiB');
    const bytes=Buffer.from(next),sha256=hash(bytes),temp=path.join(path.dirname(target),`.dc-stage-${randomUUID()}.tmp`);
    const lockKey=process.platform==='win32'?target.toLowerCase():target;
    const lockDir=path.join(path.dirname(target),`.dc-write-${hash(lockKey).slice(0,20)}.lock`);
    await fs.writeFile(path.join(lockDir,'stage.json'),JSON.stringify({name:path.basename(temp)}),{mode:0o600});
    let handle,committed=false;
    try{
      options.signal?.throwIfAborted();
      handle=await fs.open(temp,'wx',before.mode);
      await handle.writeFile(bytes,{signal:options.signal});await handle.sync();await handle.close();handle=null;
      await options.beforeCommit?.();options.signal?.throwIfAborted();
      const current=await readTextSnapshot(target,options);
      if(current.version!==before.version||current.sha256!==before.sha256)throw conflict();
      // Same-directory rename commits prepared bytes; never truncate the live target first.
      await fs.rename(temp,target);committed=true;
      const verified=await readTextSnapshot(target);
      if(verified.sha256!==sha256)throw Object.assign(new Error('Write committed but verification detected another change. Do not automatically retry.'),{code:'WRITE_VERIFY_FAILED',committed:true});
      return {bytes:bytes.length,sha256,previousSha256:before.sha256,atomic:true};
    }finally{await handle?.close().catch(()=>{});if(!committed)await fs.rm(temp,{force:true}).catch(()=>{});}
  },options);
}
