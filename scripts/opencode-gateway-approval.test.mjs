import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../app/src-tauri/src/harness/server.rs', import.meta.url), 'utf8');
const start = source.indexOf('async function call(name, args, context) {');
const end = source.indexOf('\nconst define =', start);
const makeCall = new Function('process', 'fetch', 'crypto', `${source.slice(start, end)}; return call;`);
function fixture({ denied = false, result = { ok: true, code: 'ok' } } = {}) {
  const order = [];
  const call = makeCall({env:{VIBESPACE_TOOL_GATEWAY_URL:'http://127.0.0.1:1234/v1/tool',VIBESPACE_TOOL_GATEWAY_TOKEN:'fixture'}}, async () => {
    order.push('fetch'); return {ok:true,text:async()=>JSON.stringify(result)};
  }, {randomUUID:()=> 'fixture-request'});
  const context = {sessionID:'s',messageID:'m',directory:'D:/fixture',ask:async input=>{
    order.push(input); if(denied) throw new Error('denied');
  }};
  return {call,context,order};
}
test('semantic mutation waits for native permission before gateway dispatch', async()=>{
  const f=fixture(); await f.call('terminal.spawn',{name:'Review'},f.context);
  assert.equal(f.order[0].permission,'terminal_spawn');
  assert.deepEqual(f.order[0].patterns,['terminal.spawn']);
  assert.equal(f.order[1],'fetch');
});
test('rejected native permission never invokes gateway',async()=>{
  const f=fixture({denied:true}); await assert.rejects(f.call('terminal.spawn',{},f.context),/denied/);
  assert.equal(f.order.length,1);
});
test('read-only RLM calls execute without mutation permission',async()=>{
  const f=fixture(); await f.call('vibespace_context',{operation:'describe'},f.context);
  assert.deepEqual(f.order,['fetch']);
});
test('gateway rejection is an actual failed tool result',async()=>{
  const f=fixture({result:{ok:false,code:'permission_denied'}});
  await assert.rejects(f.call('terminal.spawn',{},f.context),/permission_denied/);
});
