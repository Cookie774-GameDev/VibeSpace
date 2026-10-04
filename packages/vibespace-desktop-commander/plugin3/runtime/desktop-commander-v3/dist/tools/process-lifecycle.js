import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {terminalManager} from '../terminal-manager.js';
import {z} from 'zod';
const execute=promisify(execFile);
const response=(value,isError=false)=>({isError,content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
export const ProcessInventorySchema=z.object({pid:z.number().int().positive().optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(500).default(200)}).strict();

export async function terminateOwnedSession(args,fallback){
 const pid=args?.pid;
 if(!Number.isInteger(pid))return response({code:'INVALID_ARGUMENT',error:'An integer session pid is required.'},true);
 const session=terminalManager.getSession(pid);
 if(!session)return fallback?fallback(args):response({pid,terminated:false,completed:true,state:'not_active'});
 const child=session.process;
 if(child?.pid!==pid||child.exitCode!==null||child.signalCode!==null)return response({pid,terminated:false,completed:false,state:'already_exited',notice:'The original process exited; do not terminate a potentially reused PID. Await output/session cleanup.'});
 try{
  if(process.platform==='win32')await execute('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:10000,maxBuffer:65536});
  else{child.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,500));if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const deadline=Date.now()+10000;while(terminalManager.getSession(pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  const completed=!terminalManager.getSession(pid);
  return response({pid,terminated:true,completed,state:completed?'terminated':'cleanup_pending',scope:process.platform==='win32'?'owned terminal process tree':'owned terminal child',...(!completed?{notice:'Termination was sent, but output/session cleanup is still pending. Do not claim completion.'}:{})});
 }catch(error){
  if(!terminalManager.getSession(pid))return response({pid,terminated:false,completed:true,state:'exited_during_termination'});
  return response({pid,code:'TERMINATION_FAILED',error:String(error.message).slice(0,1000),completed:false},true);
 }
}

export async function listProcessDetails(args={},fallback){
 if(process.platform!=='win32')return fallback?fallback():response({code:'UNSUPPORTED_PLATFORM',error:'Structured inventory currently supports Windows.'},true);
 const parsed=ProcessInventorySchema.safeParse(args);if(!parsed.success)return response({code:'INVALID_ARGUMENT',error:parsed.error.message.slice(0,1000)},true);
 const script="[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress";
 const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
 try{
  let output;try{output=await execute('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});}
  catch(error){if(error.code!=='ENOENT')throw error;output=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});}
  const decoded=JSON.parse(output.stdout||'[]'),all=(Array.isArray(decoded)?decoded:[decoded]).map(process=>({pid:process.ProcessId,parent_pid:process.ParentProcessId,name:process.Name,executable_path:process.ExecutablePath??null,working_set_bytes:Number(process.WorkingSetSize)||0}));
  const {pid,offset,limit}=parsed.data,selected=all.filter(process=>!pid||process.pid===pid).sort((first,second)=>first.pid-second.pid),processes=[];let bytes=0;
  for(const process of selected.slice(offset,offset+limit)){const size=Buffer.byteLength(JSON.stringify(process));if(bytes+size>60000)break;processes.push(process);bytes+=size;}
  const nextOffset=offset+processes.length;
  return response({processes,total:selected.length,offset,next_offset:nextOffset,has_more:nextOffset<selected.length,truncated:nextOffset<selected.length,source:'live Windows CIM',notice:'Command arguments and credentials are intentionally omitted. Working set is bytes; CPU is not inferred from tasklist columns. Pagination is a fresh live snapshot each call.'});
 }catch(error){return response({code:'PROCESS_INVENTORY_FAILED',error:String(error.message).slice(0,1000)},true);}
}
