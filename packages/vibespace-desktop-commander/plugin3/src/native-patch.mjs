import {spawn} from 'node:child_process';
import {locateCodexExecutable} from './codex-reader.mjs';
const error=(code,message)=>Object.assign(Error(`${code}: ${message}`),{code});

export function nativePatchPaths(patch){
 if(typeof patch!=='string'||Buffer.byteLength(patch)>4*1024*1024)throw error('INPUT_LIMIT','Native patch must be UTF-8 text under 4 MiB.');
 const text=patch.replaceAll('\r\n','\n').trimEnd();
 if(!text.startsWith('*** Begin Patch\n')||!text.endsWith('\n*** End Patch'))throw error('INVALID_ARGUMENT','Use the native *** Begin Patch / *** End Patch format.');
 const files=[...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)],moves=[...text.matchAll(/^\*\*\* Move to: (.+)$/gm)];
 if(!files.length||files.length>64||moves.length>64)throw error('INPUT_LIMIT','Native patches require 1-64 file operations.');
 const paths=[...new Set([...files,...moves].map(match=>match[1]))];
 for(const file of paths)if(file!==file.trim()||file.includes('\0')||/^[\w+-]+:\/\//.test(file))throw error('INVALID_ARGUMENT','Patch paths must be unambiguous filesystem paths, not URIs.');
 return paths;
}

export async function applyNativePatch(root,patch){
 const executable=await locateCodexExecutable();
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,[],{argv0:'apply_patch',cwd:root,windowsHide:true,env:{...process.env,CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS:'1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,timedOut=false;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdin.on('error',()=>{});
  child.stdout.on('data',text=>{stdoutBytes+=Buffer.byteLength(text);stdout=(stdout+text).slice(0,65536);});
  child.stderr.on('data',text=>{stderrBytes+=Buffer.byteLength(text);stderr=(stderr+text).slice(0,65536);});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
  child.once('error',()=>{clearTimeout(timer);reject(error('CODEX_UNAVAILABLE','Could not start the official native patch engine.'));});
  child.once('close',(exitCode,signal)=>{
   clearTimeout(timer);resolve({source:'installed official Codex native apply_patch engine',success:exitCode===0&&!timedOut,exit_code:exitCode,signal,timed_out:timedOut,stdout,stderr,output_truncated:stdoutBytes>Buffer.byteLength(stdout)||stderrBytes>Buffer.byteLength(stderr),atomic:false,replay_safe:false,notice:'Native patch semantics, not a staged transaction. Inspect target files after any failure or timeout; never blindly replay. Parent directories must exist. Use edit_plan/apply for streamed large-file transactions and guarded rollback.'});
  });child.stdin.end(patch,'utf8');
 });
}
