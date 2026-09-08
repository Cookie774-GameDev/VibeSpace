/** Official Playwright CLI, scoped to Plugin 2 sessions. Guards are convenience,
 * not a sandbox: eval/run-code and the parent terminal remain powerful. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export const BASE=path.dirname(fileURLToPath(import.meta.url));
const ALLOWED=new Set(['open','goto','snapshot','find','click','dblclick','fill','type','press','keydown','keyup','hover','drag','drop','select','upload','check','uncheck','mousemove','mousedown','mouseup','mousewheel','screenshot','resize','eval','run-code','go-back','go-forward','reload','tab-list','tab-new','tab-select','console','network','requests','request','request-headers','response-headers','tracing-start','tracing-stop','video-start','video-stop','dialog-accept','dialog-dismiss','help']);
const OVERRIDES=/^(?:-s(?:=|$)|--(?:session|config|cdp[^=]*|profile|user-data-dir|extension|executable-path|browser|no-sandbox|output-dir|port|host|persistent|storage-state)(?:=|$))/;
export function buildInvocation(session,args){
  if(typeof session!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session))throw Error('Use a unique session name: 1–64 letters, digits, hyphens or underscores.');
  if(!Array.isArray(args)||!args.length||args.some(x=>typeof x!=='string'||x.includes('\0')))throw Error('Browser command required.');
  if(!ALLOWED.has(args[0]))throw Error('Command not permitted by the no-close wrapper. No attach, global shutdown, profile deletion, or installation.');
  if(args.slice(1).some(a=>OVERRIDES.test(a)))throw Error('Session, browser, profile, endpoint and configuration overrides are forbidden.');
  const cwd=path.join(BASE,'workspaces',session);
  if(args[0]==='open'&&!args.includes('--help')&&fs.existsSync(path.join(cwd,'opened.json')))throw Error('Session already claimed. Use goto/snapshot to reuse it, or choose a new session. Never replace a running browser.');
  const normalized=args[0]==='help'?['--help',...args.slice(1)]:args[0]==='network'?['requests',...args.slice(1)]:args;
  const config=path.join(cwd,'browser.config.json');
  const cli=path.join(BASE,'node_modules','@playwright','cli','playwright-cli.js');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PLAYWRIGHT_')));
  env.PLAYWRIGHT_CLI_SESSION='p2-'+session;
  env.NO_UPDATE_NOTIFIER='1';
  return {command:process.execPath,args:[cli,'-s=p2-'+session,...normalized],cwd,env,config};
}
export async function runBrowser(session,args){
  const run=buildInvocation(session,args);
  fs.mkdirSync(run.cwd,{recursive:true});
  // Immutable per-session config; not the user's default Playwright configuration.
  const config={browser:{browserName:'chromium',isolated:true,launchOptions:{channel:'msedge',headless:true,chromiumSandbox:true},contextOptions:{viewport:{width:1280,height:800},acceptDownloads:false}},outputDir:path.join(run.cwd,'artifacts'),outputMode:'file',timeouts:{action:10000,navigation:45000}};
  fs.mkdirSync(config.outputDir,{recursive:true});
  if(!fs.existsSync(run.config))fs.writeFileSync(run.config,JSON.stringify(config,null,2),{flag:'wx'});
  // The installed CLI expects --config on open, not on every command.
  if(args[0]==='open')run.args.push('--config='+run.config);
  // Serialize commands in each session across all callers. Do not replay timeouts.
  const lock=path.join(run.cwd,'command.lock');
  let fd;
  try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Session is busy or an interrupted command needs inspection: '+lock);throw e;}
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString(),command:args[0]}));
  const start=Date.now();let code;
  try{
    if(args[0]==='open'&&!args.includes('--help'))fs.writeFileSync(path.join(run.cwd,'opened.json'),JSON.stringify({at:new Date().toISOString(),wrapperPid:process.pid,status:'open_requested_do_not_replay'}),{flag:'wx'});
    code=await new Promise((resolve,reject)=>{
      const child=spawn(run.command,run.args,{cwd:run.cwd,env:run.env,windowsHide:true,stdio:'inherit',shell:false});
      child.once('error',reject);child.once('exit',(c,s)=>resolve(c??(s?1:0)));
    });
    return code;
  }finally{
    fs.closeSync(fd);fs.unlinkSync(lock);
    // Audit metadata only: never store typed text, credentials or URL arguments here.
    const audit=path.join(run.cwd,'actions.jsonl');
    if(fs.existsSync(audit)&&fs.statSync(audit).size>1048576){const previous=audit+'.previous';fs.rmSync(previous,{force:true});fs.renameSync(audit,previous);}
    fs.appendFileSync(audit,JSON.stringify({at:new Date().toISOString(),command:args[0],exitCode:code??null,durationMs:Date.now()-start})+'\n');
  }
}
