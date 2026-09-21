import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
export async function sharedFileOperation(file,operation,args){
 await fs.mkdir(path.dirname(file),{recursive:true});const lock=file+'.lock';let handle;
 for(let i=0;i<250;i++){try{handle=await fs.open(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,10));}}
 if(!handle)fail('SHARED_FILE_BUSY','Shared writer is busy or interrupted; inspect its lock owner before retrying. Never remove a live lock.');
 const token=randomUUID();await handle.writeFile(JSON.stringify({pid:process.pid,token,at:new Date().toISOString()}));
 try{
  const dataHandle=await fs.open(file,'a+');await dataHandle.close();const size=(await fs.stat(file)).size;if(size>64*1024*1024)fail('SHARED_FILE_FULL','Shared file exceeds 64 MiB');
  const bytes=await fs.readFile(file);if(bytes.length&&bytes.at(-1)!==10)fail('SHARED_FILE_INCOMPLETE','Final line is incomplete; preserve and inspect before writing');
  const records=bytes.length?new TextDecoder('utf-8',{fatal:true}).decode(bytes).trimEnd().split('\n').map(line=>JSON.parse(line)):[];
  if(operation==='read'){
   const selected=records.filter(r=>!args.to||r.to===args.to||r.to==='*'),offset=Math.max(0,Math.floor(args.offset||0)),limit=Math.min(100,Math.max(1,Math.floor(args.limit||20)));let remaining=16000;
   const messages=selected.slice(offset,offset+limit).map(r=>{const text=String(r.text||'').slice(0,remaining);remaining-=text.length;return {...r,text,text_truncated:text.length<String(r.text||'').length};});
   return {file,messages,next_offset:offset+messages.length,has_more:offset+messages.length<selected.length};
  }
  if(operation!=='send')fail('INVALID_ARGUMENT','Use send or read');
  const record=args.record;
  if(!record||typeof record!=='object')fail('INVALID_ARGUMENT','Record required');
  const request=record.request_id;if(!/^[\w.-]{1,120}$/.test(request||''))fail('INVALID_ARGUMENT','Unique request_id required');
  const hash=createHash('sha256').update(JSON.stringify(record)).digest('hex'),existing=records.find(r=>r.request_id===request&&r.transport===(record.transport||'shared-file'));
  if(existing){if(existing.request_sha256!==hash)fail('IDEMPOTENCY_CONFLICT','Request ID has different content');return {file,message_id:existing.message_id,written:true,duplicate:true};}
  const entry={...record,transport:record.transport||'shared-file',message_id:record.message_id||randomUUID(),request_sha256:hash,created_at:record.created_at||new Date().toISOString()};
  const line=Buffer.from(JSON.stringify(entry)+'\n');if(size+line.length>64*1024*1024)fail('SHARED_FILE_FULL','Shared file reached 64 MiB');
  const out=await fs.open(file,'a');try{await out.writeFile(line);await out.sync();}finally{await out.close();}
  return {file,message_id:entry.message_id,written:true,duplicate:false};
 }finally{await handle.close();const current=JSON.parse(await fs.readFile(lock,'utf8'));if(current.token===token)await fs.unlink(lock);}
}
