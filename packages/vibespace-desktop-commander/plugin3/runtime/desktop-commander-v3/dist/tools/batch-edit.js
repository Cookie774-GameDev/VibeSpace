import path from 'node:path';
import { z } from 'zod';
import { validatePath } from './filesystem.js';
import { MAX_TEXT_BYTES, withFileLock, readTextSnapshot, writeText } from '../utils/files/safe-text-write.js';
import { detectLineEnding, normalizeLineEndings } from '../utils/lineEndingHandler.js';
const edit=z.object({old_string:z.string().min(1).max(1048576),new_string:z.string().max(1048576),expected_replacements:z.number().int().min(1).max(100000).default(1)}).strict();
export const BatchEditSchema=z.object({files:z.array(z.object({path:z.string().min(1),expected_sha256:z.string().regex(/^[a-f0-9]{64}$/i).optional(),edits:z.array(edit).min(1).max(100)}).strict()).min(1).max(64),concurrency:z.number().int().min(1).max(4).default(1)}).strict();
function transform(text,edits){
 let next=text,replacements=0;const ending=detectLineEnding(text);
 for(const change of edits){
  const old=normalizeLineEndings(change.old_string,ending),replacement=normalizeLineEndings(change.new_string,ending);
  if(!old.isWellFormed()||!replacement.isWellFormed())throw new Error('Edit strings must contain valid Unicode characters');
  let count=0,position=0,found;
  while((found=next.indexOf(old,position))!==-1){count++;if(count>change.expected_replacements)throw new Error(`Expected ${change.expected_replacements} exact matches, found more; no changes applied to this file`);position=found+old.length;}
  if(count!==change.expected_replacements)throw new Error(`Expected ${change.expected_replacements} exact matches, found ${count}; no changes applied to this file`);
  const bytes=Buffer.byteLength(next)+count*(Buffer.byteLength(replacement)-Buffer.byteLength(old));
  if(bytes>MAX_TEXT_BYTES)throw new Error('Resulting text exceeds the 64 MiB file limit');
  next=next.split(old).join(replacement);replacements+=count;
 }
 return {text:next,replacements};
}
/** Validate every file before commits; retain only hashes and small edit requests. */
export async function batchEdit(input){
 const committed=[],targets=[],failures=[],started=new Set();let failedPath=null,phase='preflight';
 try{
  const args=BatchEditSchema.parse(input);
  if(Buffer.byteLength(JSON.stringify(args))>4*1024*1024)throw new Error('Batch payload exceeds 4 MiB');
  const seen=new Set();
  for(const file of args.files){
   failedPath=file.path;if(!path.isAbsolute(file.path))throw new Error('Absolute paths are required');
   const target=await validatePath(file.path);const key=process.platform==='win32'?target.toLowerCase():target;
   if(seen.has(key))throw new Error('Duplicate batch target');seen.add(key);targets.push({...file,path:target});
  }
  // Sequential preflight bounds memory to one file, regardless of total batch size.
  // Commit workers reacquire per-file locks and verify these exact source hashes.
  for(const file of targets){
   failedPath=file.path;const snap=await readTextSnapshot(file.path);
   if(!snap.exists)throw new Error('Edit target does not exist');
   if(file.expected_sha256!==undefined&&file.expected_sha256.toLowerCase()!==snap.sha256)throw new Error('Write conflict: stale SHA256');
   transform(snap.text,file.edits);file.preflightSha256=snap.sha256;
  }
  phase='commit';failedPath=null;let nextIndex=0;
  async function worker(){while(failures.length===0&&nextIndex<targets.length){
   const file=targets[nextIndex++];started.add(file.path);
   try{
    const receipt=await withFileLock(file.path,async target=>{
     const snap=await readTextSnapshot(target);
     if(!snap.exists||snap.sha256!==file.preflightSha256)throw new Error('Write conflict: target changed after batch preflight');
     const next=transform(snap.text,file.edits),saved=await writeText(target,next.text,'rewrite',{expectedSha256:file.preflightSha256});
     return {path:target,sha256:saved.sha256,bytes:saved.bytes,replacements:next.replacements};
    });committed.push(receipt);
   }catch(error){failures.push({path:file.path,error:error.message});}
  }}
  await Promise.all(Array.from({length:Math.min(args.concurrency,targets.length)},()=>worker()));
  const order=new Map(targets.map((f,i)=>[f.path,i]));committed.sort((a,b)=>order.get(a.path)-order.get(b.path));
  if(failures.length){failedPath=failures[0].path;throw new Error(failures.map(f=>`${f.path}: ${f.error}`).join('; '));}
  return {isError:false,content:[{type:'text',text:JSON.stringify({committed})}],structuredContent:{committed}};
 }catch(error){
  const details={phase,committed,failedPath,failures,skippedPaths:targets.filter(f=>!started.has(f.path)).map(f=>f.path),error:error.message,notice:phase==='preflight'?'Preflight failed. No target files were changed by this batch.':'In-flight operations have settled. Listed commits are verified; inspect failed targets too because a write may precede an error. Do not replay blindly.'};
  return {isError:true,content:[{type:'text',text:JSON.stringify(details)}],structuredContent:details};
 }
}
