import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createStore} from './store.mjs';
import {sharedFileOperation} from './shared-file.mjs';
const require=createRequire(new URL('../runtime/desktop-commander-v3/package.json',import.meta.url));
const bundledPython=process.env.PLUGIN3_PYTHON||fileURLToPath(new URL('../../runtime/python/python.exe',import.meta.url));
const bundledRipgrep=process.env.PLUGIN3_RIPGREP||require('@vscode/ripgrep').rgPath;
const repoScript=fileURLToPath(new URL('../extensions/codex-kit/broker_repo.py',import.meta.url));
const pythonBootstrap="import os,runpy,sys;script=sys.argv[1];sys.path.insert(0,os.path.dirname(script));sys.argv=[script,*sys.argv[2:]];runpy.run_path(script,run_name='__main__')";
const run=promisify(execFile),digest=x=>crypto.createHash('sha256').update(x).digest('hex');
export const fail=(code,message)=>{throw Object.assign(Error(`${code}: ${message}`),{code});};
const uid=prefix=>prefix+'-'+crypto.randomUUID();
const bounded=(v,d,min,max)=>Number.isInteger(v)&&v>=min&&v<=max?v:d;
const checkId=v=>{if(typeof v!=='string'||!/^[\w.-]{1,120}$/.test(v))fail('INVALID_ARGUMENT','Invalid ID');return v;};
const keyPath=p=>process.platform==='win32'?p.toLowerCase():p;
const within=(root,p)=>{const r=path.relative(root,p);return !r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
const stateMutations=new Set(['workspace_open','agent_register','agent_start','agent_send','agent_ack','agent_update','lease_claim','lease_release','job_start','job_cancel','edit_plan','edit_apply','edit_rollback']);

export async function createService(dir){
 await fs.mkdir(dir,{recursive:true});dir=await fs.realpath(dir);
 const ownerKey=digest(keyPath(dir)+os.userInfo().username).slice(0,24),owner=net.createServer(s=>s.destroy());
 const ownerEndpoint=process.platform==='win32'?`\\\\.\\pipe\\plugin3-store-${ownerKey}`:path.join(os.tmpdir(),`p3-store-${ownerKey}.sock`);
 await new Promise((resolve,reject)=>{owner.once('error',e=>reject(Object.assign(Error('SERVICE_IN_USE: a service already owns this state directory'),{code:e.code==='EADDRINUSE'?'SERVICE_IN_USE':e.code})));owner.listen(ownerEndpoint,resolve);});
 const store=createStore(path.join(dir,'service.sqlite')),children=new Map(),activeEdits=new Map();let serial=Promise.resolve(),closing=false;
 const communicationDir=path.join(dir,'communication'),communicationFile=path.join(communicationDir,'AGENT-MESSAGES.jsonl');
 await fs.mkdir(communicationDir,{recursive:true});const sharedHandle=await fs.open(communicationFile,'a');await sharedHandle.close();
 await fs.writeFile(path.join(communicationDir,'README.md'),'# Shared agent communication\n\nRead AGENT-MESSAGES.jsonl to see new messages and acknowledgements from cooperating Plugin 3 agents. One JSON object per line; filter the `to` identity. Use agent_register, then agent_send to write; the broker serializes and flushes whole records. Do not overwrite, truncate, or concurrently edit this file. Existing messages from before this feature are not imported. SQLite remains the canonical mailbox and idempotency store. Check shared_file_written in send/ack receipts. The file does not wake a model, force a host to read it, or override a denied tool call. Maximum file size 64 MiB; full or damaged files are reported without silently deleting history.\n');
 const jobs=await store.list('jobs');for(const j of jobs)if(['running','starting','cancelling'].includes(j.state)){j.state='interrupted';j.uncertain=true;await store.put('jobs',j.job,j);}
 for(const p of await store.list('edits'))if(['validating','applying','rolling_back'].includes(p.state)){p.state='uncertain';p.error='Broker interrupted; inspect transaction files before any further mutation';await store.put('edits',p.plan,p);}
 async function workspace(id){const w=await store.get('workspaces',checkId(id));if(!w)fail('WORKSPACE_NOT_FOUND','Register workspace first');return w;}
 async function resolvePath(w,p,missing=false){
  if(typeof p!=='string'||p.includes('\0')||p.length>4000)fail('INVALID_ARGUMENT','Invalid path');
  const requested=path.resolve(w.root,p);if(!within(w.root,requested))fail('OUTSIDE_WORKSPACE','Path leaves registered root');
  const rel=path.relative(w.root,requested);if(rel.split(/[\\/]/).some(s=>s.toLowerCase()==='.git'))fail('PROTECTED_PATH','.git internals are excluded');
  let real;try{real=await fs.realpath(requested);}catch(e){if(!missing||e.code!=='ENOENT')throw e;real=path.join(await fs.realpath(path.dirname(requested)),path.basename(requested));}
  if(!within(w.root,real))fail('OUTSIDE_WORKSPACE','Resolved path leaves registered root');return real;
 }
 async function agent(id){const a=await store.get('agents',checkId(id));if(!a)fail('AGENT_NOT_FOUND','Register the agent first');return a;}
 async function gitInfo(root){try{const [h,b,s]=await Promise.all(['rev-parse HEAD','branch --show-current','status --porcelain=v1 -uno'].map(cmd=>run('git',cmd.split(' '),{cwd:root,windowsHide:true,timeout:8000,maxBuffer:262144})));return {head:h.stdout.trim(),branch:b.stdout.trim(),status:s.stdout.slice(0,8000),status_truncated:s.stdout.length>8000};}catch{return {git:false};}}
 async function apply(method,a){
  if(method==='health')return {version:'0.4.0',pid:process.pid,uptime_s:process.uptime(),active_jobs:children.size,active_edits:activeEdits.size,communication_file:communicationFile,state:'ready',storage:'SQLite WAL/FULL worker',browser_persistence:'MCP reconnects survive; broker restart requires explicit attachment',capabilities:{mailboxes:true,leases:true,jobs:true,read_batch:true,query_repo:true,semantic_refactor:false,desktop_uia:false,chatgpt_host_access:'must verify in caller'}};
  if(method==='workspace_open'){
   if(!path.isAbsolute(a.root||''))fail('INVALID_ARGUMENT','Absolute root required');const root=await fs.realpath(a.root);if(!(await fs.stat(root)).isDirectory())fail('INVALID_ARGUMENT','Root must be a directory');
   const id='ws-'+digest(keyPath(root)).slice(0,20),w={workspace:id,root,created_at:new Date().toISOString()};await store.put('workspaces',id,w);return {...w,...await gitInfo(root)};
  }
  if(method==='workspace_status'){const w=await workspace(a.workspace);return {...w,...await gitInfo(w.root),leases:(await store.list('leases')).filter(l=>l.workspace===w.workspace&&l.active)};}
  if(method==='read_batch'){
   const w=await workspace(a.workspace);if(!Array.isArray(a.files)||a.files.length<1||a.files.length>64)fail('INVALID_ARGUMENT','1-64 file requests required');
   const max=bounded(a.max_bytes,262144,100,1048576),per=Math.max(1,Math.floor(max/a.files.length)),results=new Array(a.files.length);let cursor=0;
   async function readOne(f){let h;try{
    const real=await resolvePath(w,f.path);h=await fs.open(real,'r');const before=await h.stat({bigint:true});if(!before.isFile())fail('INVALID_ARGUMENT','Regular file required');
    const offset=bounded(f.offset,0,0,Number.MAX_SAFE_INTEGER),limit=bounded(f.length,per,1,1048576),length=Math.min(per,limit,Math.max(0,Number(before.size)-offset)),buf=Buffer.alloc(length);
    const {bytesRead}=await h.read(buf,0,length,offset),bytes=buf.subarray(0,bytesRead),after=await h.stat({bigint:true});
    if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)fail('CONCURRENT_CHANGE','File changed during read');
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('INVALID_UTF8_RANGE','Range splits UTF-8 or file is not UTF-8; use byte reader for binary data');}
    const complete=offset===0&&BigInt(bytesRead)===before.size;return {path:f.path,text,offset,bytes:bytesRead,size:Number(before.size),range_sha256:digest(bytes),...(complete?{sha256:digest(bytes)}:{}),complete,truncated:!complete,next_offset:offset+bytesRead,version:`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`,freshness:'live handle checked before/after'};
   }catch(e){return {path:f.path,code:e.code||'READ_ERROR',error:e.message};}finally{await h?.close();}}
   await Promise.all(Array.from({length:Math.min(8,a.files.length)},async()=>{while(cursor<a.files.length){const i=cursor++;results[i]=await readOne(a.files[i]);}}));return {workspace:w.workspace,results,max_bytes:max,all_succeeded:results.every(r=>!r.code)};
  }
  if(method==='query_repo'){
   const w=await workspace(a.workspace),max=bounded(a.max_chars,16000,100,65536),query=a.query||'';if(typeof query!=='string'||query.length>2000)fail('INVALID_ARGUMENT','Query too long');
   const args=a.mode==='files'?['--files','--hidden','-g','!.git','-g','!node_modules','-g','!target']:['--line-number','--no-heading','--fixed-strings','--hidden','-g','!.git','-g','!node_modules','-g','!target','--',query,'.'];
   try{const r=await run(bundledRipgrep,args,{cwd:w.root,windowsHide:true,timeout:10000,maxBuffer:2097152});const output=a.mode==='files'&&query?r.stdout.split(/\r?\n/).filter(x=>x.includes(query)).join('\n'):r.stdout;return {workspace:w.workspace,mode:a.mode||'text',text:output.slice(0,max),truncated:output.length>max,source:'live ripgrep; no semantic index'};}catch(e){if(e.code===1)return {workspace:w.workspace,text:'',truncated:false};if(e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return {workspace:w.workspace,text:String(e.stdout||'').slice(0,max),truncated:true,code:'OUTPUT_LIMIT'};throw e;}
  }
  if(method==='agent_register'||method==='agent_start'){
   const id=checkId(a.agent),existing=await store.get('agents',id);if(existing)fail('AGENT_EXISTS','Use existing identity or a fresh unique ID');const all=await store.list('agents');
   if(all.filter(x=>!['complete','stopped'].includes(x.state)).length>=3)fail('AGENT_LIMIT','Three active agents maximum');if(a.parent){const parent=await agent(a.parent);if(parent.parent)fail('DELEGATION_LIMIT','Recursive delegation disabled');}
   const entry={agent:id,task:String(a.task||'').slice(0,8000),model_requested:String(a.model||'').slice(0,120),model_observed:null,model_verification:'not observed',parent:a.parent||null,state:'registered',created_at:new Date().toISOString()};
   if(method==='agent_start')entry.launch={state:'awaiting_host_controller',launched:false,url:'https://chatgpt.com/',prompt:`Use Plugin 3. Read plugin3_guide. Your registered identity is ${id}; do not register again. Requested model: ${entry.model_requested}. Task: ${entry.task}. Follow repository ownership, verify actual results, and report through agent_send to your parent ${entry.parent||'(coordinator)'} when needed. Do not spawn further agents without explicit task authorization.`,instructions:'Use an authorized host browser controller, verify model and Plugin 3 selection, submit exactly once, then record actual conversation URL/model with agent_update. An uncertain send must be inspected, never automatically replayed.'};
   await store.put('agents',id,entry);return entry;
  }
  if(method==='agent_update'){
   const entry=await agent(a.agent);if(a.state&&!['registered','working','waiting','blocked','complete','stopped'].includes(a.state))fail('INVALID_ARGUMENT','Invalid agent state');
   if(['complete','stopped'].includes(entry.state)&&a.state&&a.state!==entry.state)fail('AGENT_FINISHED','Create a new identity for a new task');
   if(a.state)entry.state=a.state;if(a.evidence)entry.evidence=String(a.evidence).slice(0,8000);
   if(a.url){const u=new URL(a.url);if(u.origin!=='https://chatgpt.com'||!u.pathname.startsWith('/c/'))fail('INVALID_ARGUMENT','Actual ChatGPT conversation URL required');entry.url=u.href;}
   if(a.model_observed){entry.model_observed=String(a.model_observed).slice(0,120);entry.model_verification='caller-observed UI; server does not attest model internals';}
   if(entry.launch&&a.url&&a.model_observed)entry.launch={...entry.launch,state:'observed_by_controller',launched:true,conversation_url:entry.url};
   entry.updated_at=new Date().toISOString();await store.put('agents',entry.agent,entry);return entry;
  }
  if(method==='agent_send'){
   await agent(a.from);await agent(a.to);if(typeof a.text!=='string'||!a.text.length||a.text.length>16000)fail('INVALID_ARGUMENT','Message must be 1-16000 characters');const messages=await store.list('messages');
   if(messages.filter(m=>m.to===a.to&&!m.acknowledged).length>=1000||messages.length>=9500)fail('MAILBOX_FULL','Acknowledge and archive messages before enqueueing more');
   const sequence=(await store.get('metadata','message-sequence')||0)+1;await store.put('metadata','message-sequence',sequence);
   const m={message_id:uid('msg'),sequence,from:a.from,to:a.to,text:a.text,created_at:new Date().toISOString(),acknowledged:false};await store.put('messages',m.message_id,m);return {message_id:m.message_id,sequence,queued:true,wakes_model:false,...await publishShared({type:'message',...m,request_id:a.request_id,transport:'broker'})};
  }
  if(method==='agent_read'||method==='agent_wait'){
   await agent(a.agent);const messages=(await store.list('messages')).filter(m=>m.to===a.agent&&(a.include_acknowledged||!m.acknowledged)).sort((x,y)=>(x.sequence||0)-(y.sequence||0)||x.created_at.localeCompare(y.created_at));
   const limit=bounded(a.limit,20,1,100),selected=messages.slice(0,limit);let left=bounded(a.max_chars,24000,100,65536);
   const items=selected.map(m=>{const text=m.text.slice(0,left);left-=text.length;return {...m,text,text_truncated:text.length<m.text.length};});return {agent:a.agent,messages:items,total:messages.length,has_more:messages.length>items.length};
  }
  if(method==='agent_status')return {agents:a.agent?[await agent(a.agent)]:await store.list('agents')};
  if(method==='agent_ack'){
   await agent(a.agent);if(!Array.isArray(a.message_ids)||a.message_ids.length>100)fail('INVALID_ARGUMENT','At most 100 message IDs');
   const messages=[];for(const id of a.message_ids){const m=await store.get('messages',checkId(id));if(!m||m.to!==a.agent)fail('MESSAGE_NOT_OWNED','Message does not belong to recipient');messages.push(m);}
   for(const m of messages){m.acknowledged=true;await store.put('messages',m.message_id,m);}return {acknowledged:messages.length,...await publishShared({type:'acknowledgement',request_id:a.request_id,transport:'broker',agent:a.agent,message_ids:a.message_ids,created_at:new Date().toISOString()})};
  }
  if(method==='lease_claim'){
   await agent(a.agent);const w=await workspace(a.workspace);if(!Array.isArray(a.paths)||!a.paths.length||a.paths.length>500)fail('INVALID_ARGUMENT','1-500 exact paths required');
   const paths=await Promise.all(a.paths.map(p=>resolvePath(w,p,true))),keys=paths.map(keyPath);const leases=(await store.list('leases')).filter(l=>l.active);
   const overlap=(x,y)=>within(x,y)||within(y,x);const conflict=leases.find(l=>l.paths.some(p=>keys.some(k=>overlap(keyPath(p),k))));if(conflict)fail('LEASE_CONFLICT',`Owned by ${conflict.agent} (${conflict.lease}); expiry never authorizes stealing`);
   const l={lease:uid('lease'),agent:a.agent,workspace:w.workspace,paths,active:true,created_at:new Date().toISOString()};await store.put('leases',l.lease,l);return {...l,enforcement:'cooperating Plugin 3 clients; external editors and legacy tools remain outside this lease'};
  }
  if(method==='lease_release'){const l=await store.get('leases',checkId(a.lease));if(!l||l.agent!==a.agent)fail('LEASE_NOT_OWNED','Only the owning agent can release');if([...activeEdits.values()].some(p=>p.lease===a.lease))fail('EDIT_ACTIVE','Wait for the owned edit before releasing its lease');await requireSettledWorkspace(l.workspace);l.active=false;l.released_at=new Date().toISOString();await store.put('leases',l.lease,l);return {released:true};}
  if(method==='edit_plan'){
   await agent(a.agent);const w=await workspace(a.workspace);await requireSettledWorkspace(w.workspace);const manifestPath=await resolvePath(w,a.manifest),stat=await fs.stat(manifestPath);
   if(stat.size>4*1024*1024)fail('INPUT_LIMIT','Manifest exceeds 4 MiB');const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
   if(keyPath(await fs.realpath(manifest.root))!==keyPath(w.root)||!Array.isArray(manifest.changes)||!manifest.changes.length||manifest.changes.length>500)fail('INVALID_MANIFEST','Root and changes must match registered workspace');
   const targets=await Promise.all(manifest.changes.map(c=>resolvePath(w,c.path,true)));await requireLease(a.agent,a.lease,targets);
   const plan=uid('edit'),frozen=path.join(dir,'edits',plan+'.json');await fs.mkdir(path.dirname(frozen),{recursive:true});await fs.writeFile(frozen,JSON.stringify(manifest),{flag:'wx'});
   const entry={plan,agent:a.agent,lease:a.lease,workspace:w.workspace,targets,frozen,state:'validating',created_at:new Date().toISOString()};return launchEdit(entry,'plan',frozen,a.wait_ms);
  }
  if(method==='edit_status'){const p=await store.get('edits',checkId(a.plan));if(!p)fail('PLAN_NOT_FOUND','Unknown plan');return p;}
  if(method==='edit_apply'||method==='edit_rollback'){
   const p=await store.get('edits',checkId(a.plan));if(!p||p.agent!==a.agent)fail('PLAN_NOT_OWNED','Plan must belong to this agent');await requireSettledWorkspace(p.workspace);await requireLease(a.agent,p.lease,p.targets);
   if(method==='edit_apply'&&p.state!=='planned')fail('PLAN_STATE','Inspect plan before retrying; only planned edits can apply');
   if(method==='edit_rollback'&&(p.state!=='applied'||!p.result?.receipt))fail('PLAN_STATE','Rollback requires an applied receipt; inspect interrupted journal explicitly');
   p.state=method==='edit_apply'?'applying':'rolling_back';return launchEdit(p,method==='edit_apply'?'apply':'rollback',method==='edit_apply'?p.frozen:p.result.receipt,a.wait_ms);
  }
  if(method==='job_start'){
   if(children.size>=4)fail('JOB_LIMIT','Four active jobs maximum');const w=await workspace(a.workspace);if(typeof a.executable!=='string'||!a.executable.length||a.executable.length>4000||!Array.isArray(a.args)||a.args.length>100||a.args.some(v=>typeof v!=='string'||v.length>32000))fail('INVALID_ARGUMENT','Executable and bounded argument array required');
   const job=uid('job'),j={job,workspace:w.workspace,state:'starting',created_at:new Date().toISOString(),stdout_bytes:0,stderr_bytes:0,output_truncated:false,exit_code:null};
   await fs.mkdir(path.join(dir,'jobs'),{recursive:true});const out=await fs.open(path.join(dir,'jobs',job+'.out'),'wx'),err=await fs.open(path.join(dir,'jobs',job+'.err'),'wx');await store.put('jobs',job,j);
   let cp;try{cp=spawn(a.executable,a.args,{cwd:w.root,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});}catch(e){await out.close();await err.close();j.state='failed';j.error=e.message;await store.put('jobs',job,j);return j;}
   children.set(job,cp);j.state='running';j.pid=cp.pid??null;let writing=Promise.resolve();const cap=8*1024*1024;
   const collect=(h,field,b)=>{const remain=Math.max(0,cap-j[field]),chunk=b.subarray(0,remain);j[field]+=chunk.length;if(chunk.length<b.length)j.output_truncated=true;writing=writing.then(()=>h.write(chunk)).catch(()=>{j.output_truncated=true;});};
   cp.stdout.on('data',b=>collect(out,'stdout_bytes',b));cp.stderr.on('data',b=>collect(err,'stderr_bytes',b));cp.on('error',e=>{j.error=e.message;});
   const timer=setTimeout(()=>{j.timeout=true;void cancel(job).catch(e=>{j.error=e.message;});},bounded(a.timeout_ms,120000,100,3600000));
   cp.once('close',(code,signal)=>{clearTimeout(timer);void(async()=>{await writing;await out.sync();await err.sync();await out.close();await err.close();j.state=j.timeout?'timed_out':cp.__cancelled?'cancelled':code===0?'complete':'failed';j.exit_code=code;j.signal=signal;j.finished_at=new Date().toISOString();await store.put('jobs',job,j);children.delete(job);})().catch(async e=>{j.state='uncertain';j.error=e.message;await store.put('jobs',job,j).catch(()=>{});children.delete(job);});});
   await store.put('jobs',job,j);
   return {...j};
  }
  if(method==='job_read'||method==='job_wait'){
   const j=await store.get('jobs',checkId(a.job));if(!j)fail('JOB_NOT_FOUND','Unknown job');const offset=bounded(a.offset,0,0,Number.MAX_SAFE_INTEGER),max=bounded(a.max_bytes,32768,100,131072);
   async function tail(suffix){const h=await fs.open(path.join(dir,'jobs',j.job+suffix),'r');try{
    const size=(await h.stat()).size,buf=Buffer.alloc(Math.min(max,Math.max(0,size-offset))),{bytesRead}=await h.read(buf,0,buf.length,offset);
    const terminal=!['running','starting','cancelling'].includes(j.state);
    for(let trim=0;trim<=3&&trim<=bytesRead;trim++){if(trim&&(offset+bytesRead===size&&terminal||bytesRead===trim))break;try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buf.subarray(0,bytesRead-trim));return {text,next_offset:offset+bytesRead-trim,has_more:offset+bytesRead-trim<size,encoding:'utf8'};}catch{}}
    return {text:'',base64:buf.subarray(0,bytesRead).toString('base64'),encoding:'base64',next_offset:offset+bytesRead,has_more:offset+bytesRead<size};
   }finally{await h.close();}}
   const [out,err]=await Promise.all([tail('.out'),tail('.err')]);return {...j,stdout:out.text,stderr:err.text,stdout_page:out,stderr_page:err,stdout_next_offset:out.next_offset,stderr_next_offset:err.next_offset,has_more:out.has_more||err.has_more};
  }
  if(method==='job_cancel')return cancel(a.job);
 fail('UNKNOWN_METHOD',method);
 }
 async function publishShared(record){try{const r=await sharedFileOperation(communicationFile,'send',{record});return {shared_file:r.file,shared_file_written:r.written};}
 catch(e){return {shared_file:communicationFile,shared_file_written:false,shared_file_error:e.code||'SHARED_FILE_WRITE_FAILED',shared_file_detail:e.message};}}
 async function requireSettledWorkspace(id){const uncertain=(await store.list('edits')).find(p=>p.workspace===id&&p.state==='uncertain');if(uncertain)fail('WORKSPACE_UNCERTAIN',`Edit ${uncertain.plan} requires explicit reconciliation: verify its old worker stopped and inspect transaction journals/target hashes. Do not admit a new edit or clear its lease automatically.`);}
 async function requireLease(owner,id,targets){const lease=await store.get('leases',checkId(id));if(!lease||!lease.active||lease.agent!==owner||targets.some(t=>!lease.paths.some(p=>within(keyPath(p),keyPath(t)))))fail('LEASE_REQUIRED','Active owning lease must cover every target');}
 async function launchEdit(p,op,input,wait){
  if(activeEdits.size>=2)fail('EDIT_LIMIT','Two active edit workers maximum');
  if([...activeEdits.values()].some(e=>e.workspace===p.workspace))fail('EDIT_ACTIVE','Another edit is active in this workspace; inspect its status');
  await store.put('edits',p.plan,p);activeEdits.set(p.plan,p);
  const task=(async()=>{try{const result=await repoEngine(op,input);if(op==='plan')p.validation=result;else p.result=result;p.state=op==='plan'?'planned':op==='apply'?'applied':'rolled_back';}
   catch(e){p.state=op==='plan'?'failed':'uncertain';p.error=e.message;p.code=e.code||'EDIT_FAILED';}
   p.updated_at=new Date().toISOString();await store.put('edits',p.plan,p);activeEdits.delete(p.plan);return p;
  })();task.catch(()=>{activeEdits.delete(p.plan);});
  let timer;await Promise.race([task,new Promise(r=>{timer=setTimeout(r,bounded(wait,1000,0,25000));})]).finally(()=>clearTimeout(timer));
  const result=await store.get('edits',p.plan);if(result.code)fail(result.code,result.error);return result;
 }
 async function repoEngine(op,input){const state=path.join(dir,'repo-transactions');await fs.mkdir(state,{recursive:true});try{const r=await run(bundledPython,['-B','-X','utf8','-c',pythonBootstrap,repoScript,op,input,state],{windowsHide:true,timeout:1800000,maxBuffer:1048576});return JSON.parse(r.stdout);}catch(e){fail(e.killed?'UNCERTAIN_TIMEOUT':'EDIT_FAILED',String(e.stdout||e.message).slice(0,2000));}}
 async function cancel(id){const j=await store.get('jobs',checkId(id)),cp=children.get(id);if(!j)fail('JOB_NOT_FOUND','Unknown job');if(!cp)return {job:id,state:j.state,cancelled:false};j.cancelled=true;j.state='cancelling';await store.put('jobs',id,j);cp.__cancelled=true;
  // Only terminate a child process object created and still held by this service.
  if(process.platform==='win32'){await run('taskkill.exe',['/PID',String(cp.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(e=>{if(cp.exitCode===null)throw e;});}else cp.kill('SIGTERM');return {job:id,state:'cancelling'};
 }
 async function call(method,a={}){
  if(closing)fail('SERVICE_CLOSING','Service is draining');
  const perform=async()=>{
   if(!stateMutations.has(method))return apply(method,a);
   const request=checkId(a.request_id),hash=digest(JSON.stringify({method,args:a})),saved=await store.get('requests',request);
   if(saved){if(saved.hash!==hash)fail('IDEMPOTENCY_CONFLICT','Same request ID has different arguments');if(saved.state==='complete')return saved.result;if(saved.state==='failed')fail(saved.code,saved.error);fail('UNCERTAIN_COMPLETION','Request was interrupted; inspect actual state before further work');}
   if(await store.count('requests')>=9500)fail('RECEIPT_LIMIT','Archive completed receipts before more mutations');
   await store.put('requests',request,{hash,state:'pending',method,created_at:new Date().toISOString()});
   try{const result=await apply(method,a);await store.put('requests',request,{hash,state:'complete',result});return result;}catch(e){await store.put('requests',request,{hash,state:'failed',code:e.code||'SERVICE_ERROR',error:e.message});throw e;}
  };
  // Serialize mutations; independent observations never wait on a long-running job.
  if(stateMutations.has(method)){const p=serial.catch(()=>{}).then(perform);serial=p;return p;}
  if(method==='agent_wait'||method==='job_wait'||method==='edit_status'){const end=Date.now()+bounded(a.wait_ms,method==='edit_status'?0:1000,0,25000);let r;do{r=await perform();if(method==='agent_wait'?r.messages.length:!['running','starting','cancelling','validating','applying','rolling_back'].includes(r.state))return r;if(Date.now()>=end)return r;await new Promise(r=>setTimeout(r,150));}while(true);}
  return perform();
 }
 return {call,store,async close(){if(children.size||activeEdits.size)fail('ACTIVE_JOBS','Do not close a service with active jobs/edits');closing=true;await serial.catch(()=>{});await store.close();await new Promise(r=>owner.close(r));}};
}
