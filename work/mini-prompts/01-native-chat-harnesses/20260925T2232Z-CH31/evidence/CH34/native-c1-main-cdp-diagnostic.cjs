'use strict';
const fs = require('node:fs');
const path = require('node:path');
const receipt = { at: new Date().toISOString(), readOnly: true, port: 9223 };
(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  const main = tabs.filter(tab => tab.type === 'page' && tab.url === 'http://localhost:5173/?route=chat');
  if (main.length !== 1) throw new Error('exact_main_target_required');
  receipt.target = { id: main[0].id, url: main[0].url, title: main[0].title };
  const ws = new WebSocket(main[0].webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ws_connect_timeout')), 8000)),
  ]);
  const command = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`${method}_timeout`));
    }, 10000);
    function onMessage(event) {
      try {
        const frame = JSON.parse(event.data);
        if (frame.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
        else resolve(frame.result);
      } catch (error) { clearTimeout(timer); reject(error); }
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    receipt.frameTree = await command(1, 'Page.getFrameTree', {});
  } catch (error) { receipt.frameTreeFailure = String(error?.message ?? error); }
  try {
    receipt.runtime = await command(2, 'Runtime.evaluate', {
      expression: `({ label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
        readyState: document.readyState, activePaneCount: document.querySelectorAll('[data-testid^="chat-pane-"]').length,
        bodyChildCount: document.body?.children.length ?? null,
        title: document.title })`, returnByValue: true, awaitPromise: false,
    });
  } catch (error) { receipt.runtimeFailure = String(error?.message ?? error); }
  ws.close();
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(() => {
    const output = path.join(__dirname, `native-c1-main-cdp-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
  });
