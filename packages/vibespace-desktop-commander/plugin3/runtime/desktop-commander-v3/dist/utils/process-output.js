// Bounded, on-disk process transcripts. Never executes or retries a command.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
const defaultDirectory=process.env.PLUGIN3_DATA_DIR?path.join(process.env.PLUGIN3_DATA_DIR,'process-output'):path.join(os.homedir(),'.vibespace','desktop-link','plugin3','process-output');
const budgets=new Map();
const activeLogs=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
function trimBytes(buffer,length){let end=Math.min(length,buffer.length);while(end>0&&end<buffer.length&&(buffer[end]&0xc0)===0x80)end--;return buffer.subarray(0,end);}
export function boundedText(text,maxBytes=256*1024){const b=Buffer.from(text);return b.length<=maxBytes?text:trimBytes(b,maxBytes).toString('utf8')+'\n[Response bounded. Use the process output log with read_file byte paging for retained complete output.]';}
function budgetFor(directory,retentionMs){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 let existing=0,removed=0;
 for(const name of fs.readdirSync(directory)){
  const match=/^p2-(\d+)-.*\.log$/.exec(name);if(!match)continue;
  const file=path.join(directory,name);try{const s=fs.statSync(file);if(Date.now()-s.mtimeMs>retentionMs&&(!alive(Number(match[1])) || (Number(match[1])===process.pid&&!activeLogs.has(file)))){fs.unlinkSync(file);removed+=s.size;continue;}existing+=s.size;}catch{}
 }
 let budget=budgets.get(directory);if(!budget){budget={bytes:existing};budgets.set(directory,budget);}else budget.bytes=Math.max(budget.bytes-removed,existing);
 return budget;
}
export class ProcessOutputLog extends EventEmitter{
 constructor({directory=defaultDirectory,pid=0,maxBytes=64*1024*1024,maxTotalBytes=512*1024*1024,retentionMs=86400000}={}){
  super();this.bytes=0;this.droppedBytes=0;this.error=null;this.maxBytes=maxBytes;this.maxTotalBytes=maxTotalBytes;this.ended=false;
  try{
   this.budget=budgetFor(directory,retentionMs);
   this.path=path.join(directory,`p2-${process.pid}-${pid}-${randomUUID()}.log`);
   activeLogs.add(this.path);
   this.stream=fs.createWriteStream(this.path,{flags:'wx',mode:0o600,highWaterMark:256*1024});
   this.stream.on('drain',()=>this.emit('drain'));
   this.stream.once('close',()=>activeLogs.delete(this.path));
   this.stream.on('error',e=>{this.error=e.code||'IO_ERROR';this.emit('drain');});
  }catch(e){this.error=e.code||'IO_ERROR';}
 }
 append(text){
  const data=Buffer.from(text);
  if(this.error||this.ended||!this.stream){this.droppedBytes+=data.length;return true;}
  const available=Math.max(0,Math.min(this.maxBytes-this.bytes,this.maxTotalBytes-this.budget.bytes));
  const retained=trimBytes(data,available);this.droppedBytes+=data.length-retained.length;
  this.bytes+=retained.length;this.budget.bytes+=retained.length;
  if(!retained.length)return true;
  try{return this.stream.write(retained);}catch(e){this.error=e.code||'IO_ERROR';this.emit('drain');return true;}
 }
 async finish(){
  if(this.finished)return this.finished;this.ended=true;
  this.finished=new Promise(resolve=>{
   if(!this.stream||this.stream.closed||this.stream.destroyed||this.error){resolve();return;}
   this.stream.once('close',()=>{activeLogs.delete(this.path);resolve();});this.stream.once('error',resolve);this.stream.end();
  });return this.finished;
 }
 status(){return {path:this.path||null,bytes:this.bytes,droppedBytes:this.droppedBytes,truncated:this.droppedBytes>0,error:this.error};}
}
export function outputLogNote(log){
 if(!log)return '';const s=log.status();
 return `\n[Output log: ${s.path||'unavailable'}; retained bytes: ${s.bytes}; dropped bytes: ${s.droppedBytes}${s.error?'; log error: '+s.error:''}. Read with read_file options.byteOffset=0, maxBytes=262144 and follow nextByteOffset. Local retention: 24h; 64 MiB/session, 512 MiB aggregate. Stream may still be growing.]`;
}
