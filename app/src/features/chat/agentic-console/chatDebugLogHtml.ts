import type { ChatDebugLog } from './chatDebugLog';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const json = (value: unknown): string => escape(JSON.stringify(value, null, 2) ?? 'not recorded');
const time = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : 'not recorded';
const metric = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : 'not reported';
const raw = (label: string, value: unknown): string =>
  `<details class="technical"><summary>${escape(label)}</summary><pre>${json(value)}</pre></details>`;
const duration = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${(value / 1000).toFixed(3)} s`
    : 'not recorded';

export function renderChatDebugLogHtml(log: ChatDebugLog): string {
  const messages = log.messages
    .map((message) => {
      const usage = message.usage;
      const parts = message.parts
        .map((part) => {
          if (part.kind === 'text') return `<div class="copy">${escape(part.text)}</div>`;
          if (part.kind === 'reasoning')
            return `<details><summary>Recorded reasoning</summary><pre>${escape(part.text)}</pre></details>`;
          if (part.kind === 'tool_call')
            return `<section class="tool"><strong>Tool · ${escape(part.tool)}</strong><span class="meta">Call ${escape(part.call_id)}</span><pre>${json(part.args)}</pre></section>`;
          if (part.kind === 'tool_result')
            return `<details><summary>Tool result · ${escape(part.call_id)}${part.error ? ' · error' : ''}</summary><pre>${json(part.error ?? part.result)}</pre></details>`;
          return `<details><summary>${escape(part.kind)}</summary><pre>${json(part)}</pre></details>`;
        })
        .join('');
      return `<article><div class="eyebrow">${escape(message.role)} · ${escape(message.id)}</div><h3>${message.role === 'user' ? 'Message received / saved' : 'Message recorded'} <time>${time(message.created_at)}</time></h3>
      <p class="meta">Updated ${time(message.updated_at)} · Model ${escape(usage?.model ?? 'not reported')} · Provider ${escape(usage?.provider ?? 'not reported')}</p>
      <p class="tokens">Input ${metric(usage?.input_tokens)} · Output ${metric(usage?.output_tokens)} · Total ${metric(usage?.total_tokens)} · Cache read ${metric(usage?.cache_read_tokens)} · Cache write ${metric(usage?.cache_write_tokens)} · USD ${metric(usage?.cost_usd)} · ${escape(usage?.provenance ?? (usage ? 'recorded usage; source not specified' : 'usage unavailable'))}</p>
      ${parts}${raw('Complete message record', message)}</article>`;
    })
    .join('');
  const activities = log.activity
    .map(
      (
        event,
      ) => `<article><div class="eyebrow">${escape(event.kind)} · ${escape(event.status)}</div><h3>${escape(event.title)}</h3><p class="meta">${time(event.ts)} · ${escape(event.filePath ?? event.subtitle ?? '')}</p>
    <p>Started ${time(event.startedAt)} · Ended ${time(event.endedAt)} · Added ${metric(event.addedLines)} · Removed ${metric(event.removedLines)}</p>
    ${event.detail ? `<details><summary>Activity detail</summary><pre>${escape(event.detail)}</pre></details>` : ''}
    ${event.diff ? `<details><summary>Recorded diff · ${escape(event.status)} (not proof of a successful write)</summary><pre>${escape(event.diff)}</pre></details>` : ''}${raw('Complete activity record', event)}</article>`,
    )
    .join('');
  const runs = log.runs
    .map(({ run, events, artifacts }) => {
      const started = events.find(
        (event) => event.type === 'run_state' && event.status === 'running',
      )?.createdAt;
      const elapsed =
        started !== undefined ? (run.completedAt ?? log.exportedAt) - started : undefined;
      return `<article><div class="eyebrow">Run · ${escape(run.status)}</div><h3>${escape(run.id)}</h3><p class="meta">Model ${escape(run.model.modelId)} · Agent ${escape(run.agentId)}</p>
      <p>Created ${time(run.createdAt)} · Started ${time(started)} · Completed ${time(run.completedAt)} · Elapsed ${duration(elapsed)}</p>
      ${raw('Exact model / connection / effort snapshot', run.model)}${raw('Complete run and transport attempts', run)}
      <ol class="events">${events.map((event) => `<li><span class="meta">#${event.seq} · ${time(event.createdAt)} · ${escape(event.type)} · ${escape(event.status ?? '')}</span><strong>${escape(event.title)}</strong><p>${escape(event.safeSummary ?? '')}</p>${raw('Complete journal event', event)}</li>`).join('')}</ol>
      ${artifacts.length ? `<details><summary>${artifacts.length} recorded artifacts</summary><pre>${json(artifacts)}</pre></details>` : ''}</article>`;
    })
    .join('');
  const calls = log.messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.kind === 'tool_call').length,
    0,
  );
  const knownTokens = log.messages.flatMap(({ usage }) => {
    if (!usage || usage.provenance === 'unavailable') return [];
    const total =
      usage.total_tokens ??
      (usage.input_tokens !== undefined && usage.output_tokens !== undefined
        ? usage.input_tokens + usage.output_tokens
        : undefined);
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? [total] : [];
  });
  const tokenSubtotal = knownTokens.length
    ? knownTokens.reduce((sum, value) => sum + value, 0)
    : 'not reported';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>VibeSpace Chat Log · ${escape(log.chatId)}</title><style>
    :root{color-scheme:light;--paper:#f3f1e9;--ink:#202a2b;--muted:#526260;--line:#cbd1c8;--accent:#145f54}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 'Segoe UI',sans-serif}main{max-width:1100px;margin:auto;padding:42px 28px 80px}header{border-top:6px solid var(--accent);padding:24px 0}.eyebrow{text-transform:uppercase;font:12px/1.8 Consolas,monospace;letter-spacing:.12em;color:var(--accent)}h1{font:normal clamp(32px,5vw,56px)/1.1 Georgia,serif;margin:8px 0 20px}h2{font:normal 28px Georgia,serif;margin:38px 0 16px}h3{font-size:16px;margin:7px 0}time{font-weight:400}.meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.stats{display:flex;gap:28px;flex-wrap:wrap;border-block:1px solid var(--line);padding:16px 0}.stats strong{font:28px Georgia,serif;display:block}.controls{position:sticky;top:0;background:var(--paper);padding:14px 0;z-index:1;border-bottom:1px solid var(--line)}input[type=radio]{accent-color:var(--accent)}label{padding:10px 18px 10px 5px;cursor:pointer;font-weight:600}input:focus-visible+label{outline:2px solid var(--accent)}article{border:1px solid var(--line);border-left:4px solid var(--accent);background:#fffef9;margin:14px 0;padding:20px 24px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e9eee7;padding:14px;font:12px/1.65 Consolas,monospace;border-radius:3px;max-height:650px;overflow:auto}.copy{white-space:pre-wrap;margin:16px 0}.tokens{font:12px/1.8 Consolas,monospace}.tool{border-top:1px solid var(--line);padding-top:12px}.tool .meta{display:block}details{margin-top:12px}summary{cursor:pointer;color:var(--accent);font-weight:600}.technical{display:none}#detailed:checked~.report .technical{display:block}.events{padding-left:22px}.events li{padding:10px 0;border-bottom:1px solid var(--line)}.events strong{display:block}.coverage{font-size:13px;color:var(--muted)}footer{margin-top:40px;font-size:12px;color:var(--muted)}@media(max-width:600px){main{padding:20px 14px}article{padding:14px}.stats{gap:16px}}@media print{.controls{position:static}.technical{display:block}pre{max-height:none}article{break-inside:avoid}}
    </style></head><body><main><header><div class="eyebrow">VibeSpace / diagnostic record / v1</div><h1>Chat, on the record.</h1><p class="meta">Chat ${escape(log.chatId)} · Exported ${time(log.exportedAt)}</p><div class="stats"><div><strong>${log.messages.length}</strong>saved messages</div><div><strong>${calls}</strong>recorded tool calls</div><div><strong>${log.activity.length}</strong>activity records</div><div><strong>${log.runs.length}</strong>canonical runs</div></div><p class="meta">UI started ${time(log.rendererStartedAt)} · UI uptime at export ${duration(log.rendererUptimeMs)} · Backend uptime: not recorded</p></header>
    <input id="simple" type="radio" name="view" checked><label for="simple">Simple view</label><input id="detailed" type="radio" name="view"><label for="detailed">Detailed view</label>
    <div class="report"><p class="tokens">Known token subtotal: ${tokenSubtotal} · ${knownTokens.length} messages with totals. Estimates are included where labeled; missing usage is not counted as zero.</p><p class="coverage">Detailed view adds exact message, activity, model, transport and journal records. All timestamps are UTC. Records are grouped by source to avoid pretending unrelated events share an identity.</p>
    <details class="coverage" open><summary>Coverage and availability</summary><ul>${log.coverage.map((note) => `<li>${escape(note)}</li>`).join('')}</ul></details>
    <p>Saved backend: ${escape(log.chat?.backend_affinity?.backend ?? 'not recorded')} · Locked: ${escape(log.chat?.backend_affinity?.locked ?? 'not recorded')}</p>${raw('Saved chat metadata', log.chat)}<h2>Messages, tools & reasoning</h2>${messages || '<p>No saved messages were available.</p>'}<h2>File changes & activity</h2>${activities || '<p>No activity records were available. This does not establish that no files changed.</p>'}<h2>Run timeline</h2>${runs || '<p>No canonical run records were available.</p>'}
    ${raw('Complete sanitized snapshot', log)}</div><footer>Self-contained HTML. No network requests, remote assets or executable chat content. Re-export for newer records.</footer></main></body></html>`;
}

export function downloadChatDebugLog(log: ChatDebugLog): void {
  const url = URL.createObjectURL(
    new Blob([renderChatDebugLogHtml(log)], { type: 'text/html;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `vibespace-chat-log-${log.chatId.replace(/[^a-z0-9_-]/gi, '_')}.html`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
