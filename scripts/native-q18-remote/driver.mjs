// Prepared runtime driver. Importing this file does not connect, launch or mutate an app.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SOURCE, EXE, requireThat, validateSpec, verifyAttestation, createDeadline, inside, windowsPath, validateBinding, assertSameBinding, hasEchoOutput, safeFailure, verifyReceipt } from './contract.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_KEYS = ['sessionId','processInstanceId','runtimeGeneration','pid','processStartedAt','command'];
async function noLinks(file) {
  windowsPath(file);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part); const info = await lstat(current);
    requireThat(!info.isSymbolicLink(), 'filesystem_link');
  }
  requireThat(windowsPath(await realpath(file)) === windowsPath(file), 'filesystem_alias');
}
async function json(file, limit=8*1024*1024) {
  await noLinks(file); const info = await lstat(file);
  requireThat(info.isFile() && info.size <= limit, 'json_file_budget');
  return JSON.parse(await readFile(file,'utf8'));
}
async function hash(file) {
  await noLinks(file); const info=await lstat(file);
  requireThat(info.isFile() && info.size <= 1024**3, 'hash_file_budget');
  const h=createHash('sha256'); for await (const block of createReadStream(file,{highWaterMark:1024*1024})) h.update(block);
  return h.digest('hex');
}
function relativeFile(root, name) {
  requireThat(typeof name==='string' && name.length<=512 && !name.includes('\\') && !name.startsWith('/') && name.split('/').every(p=>p && !['.','..'].includes(p)), 'manifest_relative_path');
  const file=path.join(root,...name.split('/')); inside(root,file); return file;
}
// Source snapshot rows are distinct from the <=10,000 ZIP payload-entry budget.
// Producer snapshots every tracked file; source857 already contains 10,941 blobs.
// JSON remains bounded to 8 MiB before this validator is called.
export const INPUT_MANIFEST_MAX_ROWS = 32768;
export function verifyInputManifest(inputs) {
  requireThat(inputs && Array.isArray(inputs.files) && inputs.files.length<=INPUT_MANIFEST_MAX_ROWS, 'input_manifest_count');
  requireThat(createHash('sha256').update(JSON.stringify(inputs.files)).digest('hex')===inputs.sha256, 'input_manifest_content_hash');
  return inputs;
}
async function verifyInputs(s) {
  const inputPath=path.join(s.artifactRoot,'input-manifest.json');
  requireThat(await hash(inputPath)===s.inputManifestSHA256, 'input_manifest_file_hash');
  const inputs=await json(inputPath);
  verifyInputManifest(inputs);
  const selected=inputs.files.filter(f=>f.path==='package.json'||f.path==='package-lock.json'||(f.path.startsWith('app/')&&!f.path.startsWith('app/src-tauri/')));
  for (const required of ['package.json','package-lock.json','app/package.json','app/src/features/auth/AuthGate.tsx','app/src/features/terminals/TerminalView.tsx','app/src/features/workbench/WorkbenchPanel.tsx']) requireThat(selected.some(f=>f.path===required),'required_frontend_input');
  for (const item of selected) requireThat(await hash(relativeFile(s.frontendRoot,item.path))===item.sha256,'frontend_source_drift');
  const provenance=await json(path.join(s.artifactRoot,'provenance.json'));
  const manifest=await json(path.join(s.artifactRoot,'artifact-manifest.json'));
  requireThat(provenance.sourceCommitSHA===s.sourceSHA && provenance.build.output.sha256===s.exeSHA256 && provenance.inputSHA256===inputs.sha256,'artifact_provenance');
  requireThat(await hash(s.app.exePath)===s.exeSHA256,'staged_exe_hash');
  requireThat(Array.isArray(manifest.files) && manifest.files.length<=10000 && Array.isArray(manifest.evidenceFiles),'artifact_manifest');
  const all=[...manifest.files,...manifest.evidenceFiles]; const names=new Set();
  for(const item of all) {
    requireThat(!names.has(item.path),'artifact_manifest_duplicate'); names.add(item.path);
    const file=relativeFile(s.artifactRoot,item.path); const info=await lstat(file);
    requireThat(info.size===item.bytes && await hash(file)===item.sha256,'artifact_payload_drift');
  }
  const inventory=await json(path.join(s.artifactRoot,'dll-inventory.json'));
  requireThat(inventory.sourceSHA===s.sourceSHA && inventory.executableSHA256===s.exeSHA256 && await hash(path.join(s.artifactRoot,'dll-inventory.json'))===provenance.dllInventorySHA256,'dll_inventory_identity');
  return { inputs, selected, manifest, inventory, provenance };
}
async function probe(s,specPath,binding,timeout) {
  const args=['-NoProfile','-NonInteractive','-File',path.join(here,'attest.ps1'),'-SpecPath',specPath];
  if(binding) args.push('-ShellPid',String(binding.pid),'-ShellBornMs',String(binding.processStartedAt));
  const {stdout}=await run('pwsh',args,{windowsHide:true,timeout,maxBuffer:1024*1024});
  const observation=JSON.parse(stdout); verifyAttestation(s,observation); return observation;
}
function moduleClosure(s,o,inventory) {
  const expected=new Map(inventory.files.map(f=>[f.name.toLowerCase(),f]));
  requireThat(o.loadedModules.length<=512,'loaded_module_budget');
  const packaged=[]; const windows=[]; const other=[];
  for(const m of o.loadedModules) {
    const item=expected.get(m.name.toLowerCase());
    if(item) {
      requireThat(windowsPath(m.path)===windowsPath(path.win32.join(s.artifactRoot,'binary',item.name)) && m.sha256===item.sha256,'loaded_dll_fallback'); packaged.push(m);
    } else if(m.name.toLowerCase()==='jarvis.exe') requireThat(m.sha256===s.exeSHA256 && windowsPath(m.path)===windowsPath(s.app.exePath),'loaded_exe');
    else {
      try { inside(o.systemRoot,m.path); windows.push(m); } catch { other.push(m); }
    }
  }
  requireThat(packaged.some(m=>m.name.toLowerCase()==='directml.dll'),'directml_not_loaded');
  requireThat(other.length===0,'unapproved_loaded_module');
  return {packaged,windows,unknownNonSystemModules:other};
}
const moduleURL=(s,relative)=>'/@fs/'+path.win32.join(s.frontendRoot,relative).replaceAll('\\','/');
async function nativeList(page) { return page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('terminal_list')); }
async function offlineState(page) {
  return page.evaluate(async()=>{
    const {useAuthStore}=await import('/src/stores/auth.ts'); const {useUIStore}=await import('/src/stores/ui.ts');
    const {kernelSmokeProvider}=await import('/src/lib/ai/providers/kernelSmoke.ts');
    const a=useAuthStore.getState(); const u=useUIStore.getState();
    return {hasLocalUser:!!a.localUserId,offline:a.offlineMode===true,onboarding:u.onboardingComplete===true,hasProviderKey:Object.values(a.apiKeys??{}).some(Boolean),kernelSmokeAvailable:kernelSmokeProvider.isAvailable()};
  });
}
async function workbenchState(page) {
  return page.evaluate(async()=>{
    const {useWorkbenchStore}=await import('/src/features/workbench/store.ts');
    return useWorkbenchStore.getState().panels.map(p=>({id:p.id,kind:p.kind,title:p.title,settings:{resourceId:p.settings.resourceId??null,command:p.settings.command??null},status:p.status}));
  });
}
async function eventRow(page,marker) {
  return page.evaluate(async title=>{
    const {db}=await import('/src/lib/db/database.ts');
    const rows=await db.events.limit(1001).toArray(); if(rows.length>1000) throw new Error('smoke_event_query_budget');
    const found=rows.filter(r=>r.title===title); if(found.length>1) throw new Error('smoke_duplicate_owned_event');
    const r=found[0]; return r?{id:r.id,title:r.title,start_at:r.start_at,end_at:r.end_at,recurrence_rule:r.recurrence_rule??null,reminders:r.reminders,source:r.source,source_ref:r.source_ref??null,status:r.status}:null;
  },marker);
}
function localDate(ms) { const d=new Date(ms); return new Date(ms-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }

export async function executeNative(specPath) {
  requireThat(process.platform==='win32','windows_required');
  const s=validateSpec(await json(path.resolve(specPath),1024*1024));
  const budget=createDeadline(s.totalMs); const output=path.join(s.runnerTemp,s.taskId,'evidence');
  inside(s.runnerTemp,output); await noLinks(path.dirname(output));
  await mkdir(output); // Refuse existing evidence; never reuse an earlier attempt.
  const receipt={schema:1,taskId:s.taskId,grantId:s.grantId,sourceSHA:SOURCE,exeSHA256:EXE,runtimeStatus:'FAIL',
    steps:{identity:'UNRUN',onboarding:'UNRUN',terminal:'UNRUN',schedule:'UNRUN'},echoObserved:false,binding:null,
    cleanup:{sessionAbsent:false,originalProcessAbsent:false,eventAbsent:!s.schedule},
    providerAcceptance:'UNRUN',physicalCAcceptance:'UNRUN',canonicalToolApprovalAcceptance:'UNRUN',
    microphoneModelCloudAcceptance:'UNRUN',startedAtUTC:new Date().toISOString(),errors:[]};
  let browser,page,ownedPanelId,ownedEvent,observation,inputs,frontendBinding;
  const preparationPanels=[];
  let checkpointIndex=0;
  const checkpoint=async()=>writeFile(path.join(output,`checkpoint-${checkpointIndex++}.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  let timedOut=false;
  const watchdog=setTimeout(()=>{timedOut=true; void browser?.close().catch(()=>{});},s.totalMs);
  const guard=async(binding)=>{
    requireThat(!timedOut,'deadline_exceeded'); observation=await probe(s,specPath,binding,budget.remaining(10000));
    const f=observation.frontend; requireThat(f?.matchesRoot===true && path.win32.basename(f.exePath).toLowerCase()==='node.exe','frontend_process_root');
    if(frontendBinding) requireThat(f.pid===frontendBinding.pid && f.bornMs===frontendBinding.bornMs,'frontend_process_changed');
    else frontendBinding=f;
    return observation;
  };
  const phase=()=>{ const d=createDeadline(budget.remaining(s.phaseMs)); return ()=>Math.min(d.remaining(),budget.remaining()); };
  const wait=async(check,left)=>{
    // Bounded observation polling. No blind retry of mutations.
    for(;;) { requireThat(!timedOut,'deadline_exceeded'); if(await check()) return; const ms=left(); await new Promise(r=>setTimeout(r,Math.min(100,ms))); }
  };
  const click=async(locator,left)=>{ await guard(); await locator.click({timeout:left()}); };
  const panel=()=>page.locator(`section.workbench-panel[data-panel-id="${ownedPanelId}"]`);
  const stopPanel=async(item,left)=>{
    await guard(item.binding);
    const rows=await nativeList(page); const own=rows.find(x=>x.sessionId===item.binding.sessionId);
    if(own) {
      assertSameBinding(item.binding,own);
      const target=page.locator('section.workbench-panel[data-panel-id="'+item.id+'"]');
      await click(target.getByRole('button',{name:'Close '+item.title,exact:true}),left);
      const dialog=page.getByRole('dialog',{name:'Stop terminal?',exact:true});
      await dialog.waitFor({state:'visible',timeout:left()});
      await click(dialog.getByRole('button',{name:'Stop terminal',exact:true}),left);
    }
    await wait(async()=>!(await nativeList(page)).some(x=>x.sessionId===item.binding.sessionId),left);
    await wait(async()=>{
      const o=await guard(item.binding);
      requireThat(!o.shell || o.shell.sameBirth===true,'shell_pid_reused');
      return o.shell===null;
    },left);
    return {sessionAbsent:true,originalProcessAbsent:true};
  };
  const stopOwned=async(left)=>Object.assign(receipt.cleanup,await stopPanel({id:ownedPanelId,title:receipt.panelTitle,binding:receipt.binding},left));
  const openWorkbench=async(left)=>{
    await click(page.getByRole('button',{name:'Open command palette',exact:true}),left);
    const palette=page.getByRole('dialog',{name:'Command palette',exact:true});
    await palette.getByRole('combobox').fill('Open Workbench',{timeout:left()});
    await click(palette.getByRole('option',{name:/Open Workbench/u}),left);
    await page.getByRole('region',{name:'VibeSpace Workbench',exact:true}).waitFor({state:'visible',timeout:left()});
  };
  try {
    inputs=await verifyInputs(s); await guard();
    const requireFromWorkspace=createRequire(path.join(s.frontendRoot,'package.json'));
    const {chromium}=requireFromWorkspace('playwright-core');
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`,{timeout:budget.remaining(90000)});
    const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()===s.mainURL);
    requireThat(pages.length===1,'main_target_ambiguous'); page=pages[0];
    page.setDefaultTimeout(Math.min(s.phaseMs,budget.remaining())); page.setDefaultNavigationTimeout(Math.min(s.phaseMs,budget.remaining()));
    const label=await page.evaluate(()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label);
    requireThat(label===s.windowLabel,'tauri_main_window');
    const actualDataPath=await page.evaluate(async url=>(await import(url)).appDataDir(),moduleURL(s,'node_modules/@tauri-apps/api/path.js'));
    requireThat(windowsPath(actualDataPath.replace(/[\\/]$/u,''))===windowsPath(s.nativeDataPath),'actual_native_data_path');
    const cdp=await page.context().newCDPSession(page); const target=await cdp.send('Target.getTargetInfo'); await cdp.detach();
    requireThat(target.targetInfo.type==='page' && target.targetInfo.url===s.mainURL,'cdp_main_target');
    receipt.targetId=target.targetInfo.targetId; receipt.attestation=observation;
    receipt.loadedModules=moduleClosure(s,observation,inputs.inventory); receipt.steps.identity='PASS';
    await checkpoint();

    let left=phase(); const onboarding=page.getByRole('dialog',{name:'Onboarding',exact:true});
    const present=await onboarding.isVisible(); receipt.onboardingEntry=present?'ordinary_first_run_UI':'existing_offline_state';
    if(present) {
      for(const [step,name] of [[1,'Get started'],[2,'Next'],[3,'Continue'],[4,'Save & continue'],[5,'Next'],[6,'Open Jarvis']]) {
        await onboarding.getByText(new RegExp(`Step ${step} of 6:`)).waitFor({state:'attached',timeout:left()});
        await click(onboarding.getByRole('button',{name,exact:true}),left);
      }
      await onboarding.waitFor({state:'hidden',timeout:left()});
      await click(page.getByRole('button',{name:/Run fully offline instead/u}),left);
    }
    await wait(async()=>{const a=await offlineState(page); requireThat(!a.kernelSmokeAvailable,'kernel_smoke_bypass'); return a.hasLocalUser&&a.offline&&a.onboarding&&!a.hasProviderKey;},left);
    receipt.offlineState=await offlineState(page);
    await guard(); await page.reload({timeout:left(),waitUntil:'domcontentloaded'});
    await wait(async()=>{const a=await offlineState(page); requireThat(!a.kernelSmokeAvailable,'kernel_smoke_bypass'); return a.hasLocalUser&&a.offline&&a.onboarding&&!a.hasProviderKey;},left);
    receipt.steps.onboarding='PASS';
    await checkpoint();

    left=phase(); requireThat((await nativeList(page)).length===0,'baseline_terminal_not_empty');
    const existingPanels=await workbenchState(page);
    // Future consumer admission includes TWO default PTYs; preparation is real UI only.
    if(existingPanels.length) {
      requireThat(s.cleanProfileReceipt.ordinaryBlankWorkbenchPreparation===false,'unexpected_prepared_layout');
      const defaults=existingPanels.filter(p=>p.kind==='terminal');
      requireThat(existingPanels.length===5 && defaults.length===2 && defaults.every(p=>!p.settings.command&&['Terminal 1','Terminal 2'].includes(p.title)),'unexpected_first_run_layout');
      receipt.preparation={kind:'ordinary_default_coding_to_blank_UI',maximumPTYs:2,terminals:[]};
      await openWorkbench(left);
      await wait(async()=>{
        const panels=await workbenchState(page); const rows=await nativeList(page);
        requireThat(rows.length<=2,'preparation_pty_budget');
        if(rows.length!==2 || defaults.some(p=>!panels.find(q=>q.id===p.id)?.settings.resourceId)) return false;
        for(const p of defaults) {
          requireThat(/^[a-z0-9_-]+$/iu.test(p.id),'panel_id');
          const actual=panels.find(q=>q.id===p.id); requireThat(!actual.settings.command,'preparation_autorun');
          const row=rows.find(r=>r.sessionId===actual.settings.resourceId); validateBinding(row);
          const binding=Object.fromEntries(CHECK_KEYS.map(k=>[k,row[k]]));
          const o=await guard(binding); requireThat(o.shell?.sameBirth===true&&o.shell.parentPid===s.app.pid,'preparation_shell_birth');
          preparationPanels.push({id:p.id,title:p.title,binding,cleanup:null});
        }
        return true;
      },left);
      receipt.preparation.terminals=preparationPanels; await checkpoint();
      for(const p of preparationPanels) {p.cleanup=await stopPanel(p,left);await checkpoint();}
      requireThat((await nativeList(page)).length===0,'preparation_session_leak');
      await click(page.getByRole('button',{name:'Templates',exact:true}),left);
      const picker=page.getByRole('dialog',{name:'Layouts & templates',exact:true});
      const blank=picker.locator('article').filter({has:page.getByRole('heading',{name:'Blank Workbench',exact:true})});
      await click(blank.getByRole('button',{name:'Apply',exact:true}),left);
      await wait(async()=>(await workbenchState(page)).length===0,left);
      receipt.preparation.blankUiApplied=true; await checkpoint();
    } else {
      requireThat(s.cleanProfileReceipt.ordinaryBlankWorkbenchPreparation===true,'blank_preparation_receipt_required');
      await openWorkbench(left);
    }
    requireThat((await nativeList(page)).length===0&&(await workbenchState(page)).length===0,'blank_preparation_effect');
    left=phase();
    await click(page.getByRole('button',{name:'Add Terminal',exact:true}),left);
    await wait(async()=>{
      const p=(await workbenchState(page)).filter(p=>p.kind==='terminal');
      requireThat(p.length<=1,'multiple_terminal_panels');
      if(p.length===1) { requireThat(!p[0].settings.command,'terminal_autorun_requested'); requireThat(/^[a-z0-9_-]+$/iu.test(p[0].id),'panel_id'); ownedPanelId=p[0].id; receipt.panelTitle=p[0].title; return !!p[0].settings.resourceId; }
      return false;
    },left);
    await wait(async()=>{
      const rows=await nativeList(page); requireThat(rows.length<=1,'multiple_native_terminals');
      if(rows.length===1) { receipt.binding=Object.fromEntries(CHECK_KEYS.map(k=>[k,rows[0][k]])); validateBinding(receipt.binding); return true; } return false;
    },left);
    const current=(await workbenchState(page)).find(p=>p.id===ownedPanelId);
    requireThat(current.settings.resourceId===receipt.binding.sessionId,'panel_session_binding');
    receipt.noAutorunSettings=current.settings.command===null;
    const shell=await guard(receipt.binding);
    requireThat(shell.shell?.sameBirth===true && shell.shell.parentPid===s.app.pid,'real_shell_birth_parent');
    await checkpoint();
    const marker=`FRESH2_NATIVE_${s.taskId}`;
    await page.evaluate(async({url,sid})=>{
      const {listen}=await import(url); const state={sid,output:'',overflow:false};
      window.__FRESH2_NATIVE_SMOKE=state;
      state.unlisten=await listen('terminal://output',e=>{
        if(e.payload?.sessionId!==state.sid || typeof e.payload.data!=='string') return;
        if(state.output.length+e.payload.data.length>262144) {state.overflow=true;return;} state.output+=e.payload.data;
      });
    },{url:moduleURL(s,'node_modules/@tauri-apps/api/event.js'),sid:receipt.binding.sessionId});
    const terminal=panel().locator('.xterm-helper-textarea'); await terminal.focus({timeout:left()});
    await guard(receipt.binding); await terminal.pressSequentially(`echo ${marker}`,{timeout:left()});
    await terminal.press('Enter',{timeout:left()});
    await wait(async()=>{
      const output=await page.evaluate(()=>({text:window.__FRESH2_NATIVE_SMOKE.output,overflow:window.__FRESH2_NATIVE_SMOKE.overflow}));
      requireThat(!output.overflow,'terminal_output_budget'); return hasEchoOutput(output.text,marker);
    },left);
    receipt.echoObserved=true; receipt.echoMarker=marker;
    await click(panel().getByRole('button',{name:`Close ${receipt.panelTitle}`,exact:true}),left);
    const dialog=page.getByRole('dialog',{name:'Stop terminal?',exact:true}); await dialog.waitFor({state:'visible',timeout:left()});
    await click(dialog.getByRole('button',{name:'Cancel',exact:true}),left); await dialog.waitFor({state:'hidden',timeout:left()});
    assertSameBinding(receipt.binding,(await nativeList(page)).find(x=>x.sessionId===receipt.binding.sessionId));
    requireThat((await guard(receipt.binding)).shell?.sameBirth===true,'cancel_close_stopped_shell');
    receipt.cancelClosePreservedBinding=true;
    await stopOwned(left); receipt.steps.terminal='PASS';
    await checkpoint();
    await page.screenshot({path:path.join(output,'terminal-cleanup.png'),timeout:left()});

    if(s.schedule) {
      left=phase(); const marker=`FRESH2_EVENT_${s.taskId}`;
      requireThat(await eventRow(page,marker)===null,'event_marker_collision');
      await click(page.getByRole('button',{name:'Schedule',exact:true}),left);
      const editor=page.locator('#schedule-editor'); await editor.waitFor({state:'visible',timeout:left()});
      await click(editor.getByRole('button',{name:'Event',exact:true}),left);
      await editor.locator('#event-title').fill(marker,{timeout:left()});
      const start=Date.now()+7*86400000; await editor.locator('#event-start').fill(localDate(start),{timeout:left()});
      await editor.locator('#event-end').fill(localDate(start+3600000),{timeout:left()});
      await click(editor.getByRole('button',{name:'No repeat',exact:true}),left);
      const reminderGroup=editor.locator('[data-warm-surface="schedule-field-group"]').filter({hasText:'Reminders'});
      const reminders=reminderGroup.locator('button[aria-pressed="true"]');
      while(await reminders.count()) await click(reminders.first(),left);
      await click(editor.getByRole('button',{name:'Save event',exact:true}),left);
      await wait(async()=>{ownedEvent=await eventRow(page,marker); return !!ownedEvent;},left);
      requireThat(ownedEvent.start_at>Date.now()+6*86400000 && !ownedEvent.recurrence_rule && ownedEvent.reminders.length===0 && ownedEvent.source==='manual' && !ownedEvent.source_ref,'event_not_inert');
      await guard(); await page.reload({timeout:left(),waitUntil:'domcontentloaded'});
      await wait(async()=>JSON.stringify(await eventRow(page,marker))===JSON.stringify(ownedEvent),left);
      receipt.schedule={id:ownedEvent.id,title:marker,start_at:ownedEvent.start_at,persistence:'PASS',canonicalToolApproval:'UNRUN'};
      await click(page.getByRole('button',{name:`Delete ${marker}`,exact:true}),left);
      await wait(async()=>await eventRow(page,marker)===null,left); receipt.cleanup.eventAbsent=true;
      receipt.steps.schedule='PASS';
      await checkpoint();
    }
    await verifyInputs(s); await guard(); receipt.loadedModules=moduleClosure(s,observation,inputs.inventory);
    receipt.runtimeStatus='PASS'; verifyReceipt(receipt);
  } catch(error) { receipt.errors.push(safeFailure(error)); }
  finally {
    // UI cleanup is attempted only for the owned binding, before the global deadline.
    if(receipt.binding && !receipt.cleanup.sessionAbsent && page && !timedOut) {
      try { await stopOwned(phase()); } catch(error) { receipt.errors.push(safeFailure(error)); }
    }
    for(const p of preparationPanels.filter(p=>!p.cleanup)) {
      if(page&&!timedOut) try {p.cleanup=await stopPanel(p,phase());} catch(error) {receipt.errors.push(safeFailure(error));}
    }
    if(ownedEvent && !receipt.cleanup.eventAbsent && page && !timedOut) {
      try { const left=phase(); const actual=await eventRow(page,ownedEvent.title);
        requireThat(actual?.id===ownedEvent.id,'cleanup_event_identity');
        await click(page.getByRole('button',{name:`Delete ${ownedEvent.title}`,exact:true}),left);
        await wait(async()=>await eventRow(page,ownedEvent.title)===null,left); receipt.cleanup.eventAbsent=true;
      } catch(error) {receipt.errors.push(safeFailure(error));}
    }
    if(page && !timedOut) await page.evaluate(()=>{window.__FRESH2_NATIVE_SMOKE?.unlisten?.();delete window.__FRESH2_NATIVE_SMOKE;}).catch(()=>{});
    clearTimeout(watchdog); await browser?.close().catch(()=>{});
    receipt.finishedAtUTC=new Date().toISOString(); verifyReceipt(receipt);
    // Only sanitized receipt data; no raw exceptions, keys, profile database or terminal transcript.
    await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  }
  requireThat(receipt.runtimeStatus==='PASS','runtime_scenarios_failed'); return receipt;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { requireThat(process.argv.length===4 && process.argv[2]==='--execute-native','explicit_runtime_flag_required');
    await executeNative(path.resolve(process.argv[3])); console.log(JSON.stringify({status:'PASS'}));
  } catch(error) {console.log(JSON.stringify({status:'FAIL',reason:safeFailure(error)}));process.exitCode=1;}
}
