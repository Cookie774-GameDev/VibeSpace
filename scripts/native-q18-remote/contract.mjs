import path from 'node:path';
export const SOURCE = '8579072d21e6a994b3c95f44997922997679324a';
export const EXE = '23974fdf89067d4f2399b0f367c54ce64e9350f82e4cdca38b11652aee61956e';
export function requireThat(ok, code) { if (!ok) throw new Error(`smoke_${code}`); }
const exact = (value, keys) => requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(value, k)), 'schema_keys');
const integer = n => Number.isSafeInteger(n) && n > 0;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 1024;
export function windowsPath(value) {
  requireThat(text(value) && /^[A-Za-z]:[\\/]/u.test(value), 'absolute_local_path');
  const parts = value.replaceAll('/', '\\').slice(3).split('\\');
  requireThat(parts.every(p => p && !['.', '..'].includes(p) && !/[<>:"|?*\x00-\x1f]/u.test(p) && !/[ .]$/u.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)), 'path_alias');
  return path.win32.normalize(value).toLowerCase();
}
export function inside(root, file) {
  root = windowsPath(root); file = windowsPath(file);
  requireThat(file.startsWith(root + '\\'), 'path_escape');
  return file;
}
export function validateSpec(s, now = Date.now()) {
  exact(s, ['schema','taskId','grantId','issuedAtMs','expiresAtMs','sourceSHA','exeSHA256','workspace','runnerTemp','artifactRoot','frontendRoot','inputManifestSHA256','app','webview','cdpPort','mainURL','windowLabel','nativeDataPath','cleanProfileReceipt','phaseMs','totalMs','schedule']);
  requireThat(s.schema === 1 && /^[A-Z0-9_]{8,64}$/u.test(s.taskId) && /^[A-Za-z0-9_-]{5,128}$/u.test(s.grantId), 'task_grant');
  requireThat(s.sourceSHA === SOURCE && s.exeSHA256 === EXE && /^[a-f0-9]{64}$/u.test(s.inputManifestSHA256), 'frozen_identity');
  requireThat(integer(s.issuedAtMs) && integer(s.expiresAtMs) && s.issuedAtMs <= now && now < s.expiresAtMs && s.expiresAtMs - s.issuedAtMs <= 900000, 'expired_authority');
  requireThat(integer(s.phaseMs) && s.phaseMs <= 60000 && integer(s.totalMs) && s.totalMs <= 900000 && typeof s.schedule === 'boolean', 'deadline_budget');
  windowsPath(s.workspace); windowsPath(s.runnerTemp); windowsPath(s.nativeDataPath);
  requireThat(windowsPath(s.artifactRoot) === windowsPath(path.win32.join(s.runnerTemp, s.taskId, 'staging', 'build')), 'artifact_task_scope');
  requireThat(windowsPath(s.frontendRoot) === windowsPath(s.workspace), 'frontend_workspace');
  exact(s.app, ['pid','bornMs','exePath']); exact(s.webview, ['pid','bornMs','exePath','profile']);
  for (const p of [s.app, s.webview]) requireThat(integer(p.pid) && integer(p.bornMs) && text(p.exePath), 'process_identity');
  requireThat(windowsPath(s.app.exePath) === windowsPath(path.win32.join(s.artifactRoot, 'binary', 'jarvis.exe')), 'staged_exe_path');
  requireThat(path.win32.basename(windowsPath(s.webview.exePath)) === 'msedgewebview2.exe', 'official_webview');
  inside(s.runnerTemp, s.webview.profile);
  requireThat(s.app.pid !== s.webview.pid && integer(s.cdpPort) && s.cdpPort >= 1024 && s.cdpPort <= 65535, 'cdp_port');
  requireThat(s.mainURL === 'http://localhost:5173/' && s.windowLabel === 'main', 'official_main_url');
  exact(s.cleanProfileReceipt, ['capturedAtMs','nativeDataAbsentBeforeStart','webviewProfileAbsentBeforeStart','ordinaryBlankWorkbenchPreparation']);
  requireThat(integer(s.cleanProfileReceipt.capturedAtMs) && s.cleanProfileReceipt.capturedAtMs < s.app.bornMs && s.cleanProfileReceipt.nativeDataAbsentBeforeStart === true && s.cleanProfileReceipt.webviewProfileAbsentBeforeStart === true && typeof s.cleanProfileReceipt.ordinaryBlankWorkbenchPreparation === 'boolean', 'clean_profile_receipt');
  return s;
}
export function verifyAttestation(s, o, now = Date.now()) {
  validateSpec(s, now);
  requireThat(integer(o.capturedAtMs) && 0 <= now - o.capturedAtMs && now - o.capturedAtMs <= 10000, 'stale_attestation');
  requireThat(o.sourceSHA === s.sourceSHA && o.exeSHA256 === s.exeSHA256, 'machine_source_exe');
  for (const k of ['app','webview']) requireThat(o[k]?.pid === s[k].pid && o[k]?.bornMs === s[k].bornMs && windowsPath(o[k]?.exePath) === windowsPath(s[k].exePath), 'pid_birth_changed');
  requireThat(o.profileMatches === true && o.debugPortMatches === true, 'profile_debugport');
  const byPid = new Map(o.processes.map(p => [p.pid,p]));
  requireThat(byPid.size === o.processes.length && o.processes.length <= 512, 'process_inventory');
  let cursor = s.webview.pid; const seen = new Set();
  for (let i=0; i<32 && cursor !== s.app.pid; i++) {
    requireThat(!seen.has(cursor) && byPid.has(cursor), 'foreign_webview');
    seen.add(cursor); cursor = byPid.get(cursor).parentPid;
  }
  requireThat(cursor === s.app.pid, 'foreign_webview');
  requireThat(o.listener?.ownerPid === s.webview.pid && o.listener.port === s.cdpPort && ['127.0.0.1','::1'].includes(o.listener.address), 'listener_ownership');
  requireThat(text(o.webviewRuntimeVersion) && o.nativeDataExists === true, 'runtime_native_data');
  return o;
}
export function createDeadline(ms, clock = () => performance.now()) {
  requireThat(integer(ms) && ms <= 900000, 'deadline_budget');
  const start = clock(); requireThat(Number.isFinite(start), 'clock_invalid'); let last = start;
  return { remaining(cap = ms) { const now = clock(); requireThat(Number.isFinite(now) && now >= last, 'clock_reversed'); last = now;
    const left = Math.floor(ms - (now-start)); requireThat(left > 0, 'deadline_exceeded'); return Math.min(left, cap); } };
}
export function validateBinding(b) {
  requireThat(b && ['sessionId','processInstanceId','runtimeGeneration'].every(k => text(b[k])) && integer(b.pid) && integer(b.processStartedAt), 'terminal_binding');
  requireThat(/^(powershell|pwsh)(\.exe)?$/iu.test(b.command ?? ''), 'terminal_not_local_shell');
  return b;
}
export function assertSameBinding(a,b) {
  validateBinding(a); validateBinding(b);
  requireThat(['sessionId','processInstanceId','runtimeGeneration','pid','processStartedAt','command'].every(k => a[k]===b[k]), 'terminal_binding_changed');
}
export function hasEchoOutput(output, marker) {
  const clean = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu,'');
  return clean.split(/[\r\n]/u).some(line => line.trim() === marker);
}
export function safeFailure(error) { return /^smoke_[a-z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'unexpected_failure'; }
export function verifyReceipt(r) {
  requireThat(r.sourceSHA === SOURCE && r.exeSHA256 === EXE && r.providerAcceptance === 'UNRUN' && r.physicalCAcceptance === 'UNRUN', 'receipt_scope');
  if (r.runtimeStatus === 'PASS') {
    requireThat(['identity','onboarding','terminal'].every(k => r.steps[k] === 'PASS') && r.echoObserved === true && r.cancelClosePreservedBinding === true && r.noAutorunSettings === true, 'receipt_missing_effect');
    validateBinding(r.binding);
    requireThat(r.cleanup?.sessionAbsent === true && r.cleanup.originalProcessAbsent === true, 'receipt_cleanup_missing');
    if (r.steps.schedule === 'PASS') requireThat(r.cleanup.eventAbsent === true && text(r.schedule?.id), 'receipt_event_cleanup_missing');
  }
  return r;
}
