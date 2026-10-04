import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const error=(code,message)=>Object.assign(Error(`${code}: ${message}`),{code});
export async function locateCodexExecutable(){
 if(process.env.PLUGIN3_CODEX_EXECUTABLE)return process.env.PLUGIN3_CODEX_EXECUTABLE;
 const directories=(process.env.PATH||'').split(path.delimiter).filter(Boolean);
 for(const directory of directories){
  const candidates=process.platform==='win32'?[
   path.join(directory,'codex.exe'),
   path.join(directory,'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
   path.join(directory,'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
  ]:[path.join(directory,'codex')];
  for(const candidate of candidates){try{if((await fs.stat(candidate)).isFile())return candidate;}catch{}}
 }
 throw error('CODEX_UNAVAILABLE','Install the official Codex CLI or set PLUGIN3_CODEX_EXECUTABLE to its executable path.');
}

export function createCodexReader({executable,spawnProcess=spawn,timeout_ms=15000}={}){
 let child=null,ready=null,sequence=0;const pending=new Map();
 function stop(process,errorValue){
  if(child!==process)return;child=null;ready=null;
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(errorValue);}pending.clear();
  process.stdin.destroy();process.kill();
 }
 function send(process,method,params){
  if(pending.size>=8)return Promise.reject(error('CODEX_BUSY','Eight concurrent Codex reads are already active.'));
  return new Promise((resolve,reject)=>{
   const requestId=++sequence,timer=setTimeout(()=>stop(process,error('CODEX_TIMEOUT','Read timed out; the owned sidecar was closed.')),timeout_ms);
   pending.set(requestId,{resolve,reject,timer});
   process.stdin.write(JSON.stringify({id:requestId,method,params})+'\n',writeError=>{if(writeError)stop(process,error('CODEX_CONNECTION_CLOSED','Sidecar input closed.'));});
  });
 }
 async function connect(){
  if(ready)return ready;
  ready=(async()=>{
   const process=spawnProcess(executable||await locateCodexExecutable(),['app-server'],{windowsHide:true,stdio:['pipe','pipe','pipe']});child=process;
   let buffer='';const decoder=new StringDecoder('utf8');process.stderr.resume();
   process.on('error',()=>stop(process,error('CODEX_UNAVAILABLE','Could not start the official Codex app-server.')));
   process.on('exit',()=>stop(process,error('CODEX_CONNECTION_CLOSED','The owned Codex app-server exited.')));
   process.stdout.on('data',bytes=>{
    buffer+=decoder.write(bytes);if(Buffer.byteLength(buffer)>16*1024*1024){stop(process,error('CODEX_OUTPUT_LIMIT','Protocol response exceeded 16 MiB; request a smaller page.'));return;}
    let newline;while((newline=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let response;
     try{response=JSON.parse(line);}catch{stop(process,error('CODEX_PROTOCOL_ERROR','Invalid JSON from Codex app-server.'));return;}
     const request=pending.get(response.id);
     if(request&&('result' in response||'error' in response)){
      pending.delete(response.id);clearTimeout(request.timer);
      if(response.error)request.reject(error('CODEX_PROTOCOL_ERROR',String(response.error.message||'Unsupported read method').slice(0,500)));else request.resolve(response.result);
     }else if(response.method&&response.id!==undefined){
      process.stdin.write(JSON.stringify({id:response.id,error:{code:-32601,message:'Plugin 3 read-only bridge does not handle interactive or mutation requests'}})+'\n');
     }
    }
   });
   await send(process,'initialize',{clientInfo:{name:'plugin3-readonly',version:'0.4.5'},capabilities:{experimentalApi:true}});
   process.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return process;
  })().catch(startError=>{if(child)stop(child,startError);ready=null;throw startError;});
  return ready;
 }
 async function call(args){
  const methods={list:'thread/list',read:'thread/read',turns:'thread/turns/list',items:'thread/items/list'},method=methods[args.operation];
  if(!method)throw error('INVALID_ARGUMENT','Only list, read, turns and items are allowed.');
  if(args.operation!=='list'&&!args.thread_id)throw error('INVALID_ARGUMENT','An explicit thread_id is required.');
  const limit=args.limit??20,maxChars=args.max_chars??16000;let params;
  if(args.operation==='list')params={limit,useStateDbOnly:true,...(args.cursor?{cursor:args.cursor}:{}),...(args.cwd?{cwd:args.cwd}:{}),...(args.search?{searchTerm:args.search}:{}),archived:args.archived??false};
  else if(args.operation==='read')params={threadId:args.thread_id,includeTurns:false};
  else params={threadId:args.thread_id,limit,...(args.cursor?{cursor:args.cursor}:{}),sortDirection:args.sort_direction??'asc',...(args.operation==='turns'?{itemsView:'summary'}:args.turn_id?{turnId:args.turn_id}:{})};
  const process=await connect(),result=await send(process,method,params),serialized=JSON.stringify(result),truncated=serialized.length>maxChars;
  let text=serialized.slice(0,maxChars);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  return {source:'official Codex CLI app-server',method,read_only:true,inference_started:false,text,truncated,total_chars:serialized.length,...(!truncated&&result?.nextCursor?{next_cursor:result.nextCursor}:{}),...(truncated?{guidance:'Reduce limit or increase max_chars; text is an explicit JSON prefix, not a complete page.'}:{})};
 }
 return {call,async close(){if(child)stop(child,error('CODEX_CONNECTION_CLOSED','Reader closed by its owner.'));}};
}
