import test from 'node:test';
import assert from 'node:assert/strict';
import { startLiveLog } from './server.mjs';
import { chooseNativeTarget } from './capture.mjs';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('selects only one main native development target, excluding auxiliary windows', () => {
  const target = { type: 'page', title: 'VibeSpace', url: 'http://localhost:5173/?route=chat' };
  assert.equal(chooseNativeTarget([target, { ...target, url: 'http://localhost:5173/?view=pet-overlay' }]), target);
  assert.throws(() => chooseNativeTarget([target, target]));
  assert.throws(() => chooseNativeTarget([{ ...target, url: 'https://example.com' }]));
});

test('serves real reader output only on the private loopback URL and rejects foreign origins', async (t) => {
  let captured;
  const { server, url } = await startLiveLog({ port: 0, readSnapshot: async (chat) => {
    captured = chat; return { chatId: chat, chats: [], html: '<p>recorded data</p>', messages: 1, runs: 0 };
  } });
  t.after(() => server.close());
  assert.equal((await fetch(new URL('/', url))).status, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Live Chat Log/);
  const result = await (await fetch(url + 'snapshot?chat=chosen-chat')).json();
  assert.equal(captured, 'chosen-chat');
  assert.equal(result.html, '<p>recorded data</p>');
});

test('reports disconnection without leaking backend errors and prevents concurrent reads', async (t) => {
  let rejectRead;
  let began;
  const ready = new Promise((resolve) => { began = resolve; });
  const { server, url } = await startLiveLog({ port: 0, readSnapshot: () => new Promise((_, reject) => { rejectRead = reject; began(); }) });
  t.after(() => server.close());
  const first = fetch(url + 'snapshot');
  await ready;
  assert.equal((await fetch(url + 'snapshot')).status, 429);
  rejectRead(new Error('private error and credential'));
  const response = await first;
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private error/);
});

test('standalone HTML refreshes actual payloads and clears the report on disconnect', async () => {
  const source = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
  let refresh;
  let fail = false;
  const payload = { chats: [{ id: 'chat-1', title: '<script>untrusted title</script>' }], chatId: 'chat-1', html: '<p>real captured record</p>', messages: 1, runs: 2, updatedAt: 1000 };
  const dom = new JSDOM(source, { url: 'http://127.0.0.1:42841/private/', runScripts: 'dangerously', beforeParse(window) {
    window.AbortSignal = AbortSignal;
    window.fetch = async () => ({ ok: !fail, json: async () => payload });
    window.setTimeout = (callback) => { refresh = callback; return 1; };
  } });
  try {
    await new Promise(setImmediate);
    const doc = dom.window.document;
    assert.match(doc.querySelector('#status').textContent, /LIVE.*Connected/);
    assert.equal(doc.querySelector('iframe').srcdoc, payload.html);
    assert.equal(doc.querySelector('#chat').options[1].textContent, payload.chats[0].title);
    assert.equal(doc.querySelector('#chat script'), null);
    payload.html = '<p>updated actual record</p>';
    await refresh();
    assert.equal(doc.querySelector('iframe').srcdoc, payload.html);
    fail = true;
    await refresh();
    assert.match(doc.querySelector('#status').textContent, /DISCONNECTED/);
    assert.equal(doc.querySelector('iframe').srcdoc, '');
    assert.equal(doc.querySelector('#download').disabled, true);
  } finally { dom.window.close(); }
});
