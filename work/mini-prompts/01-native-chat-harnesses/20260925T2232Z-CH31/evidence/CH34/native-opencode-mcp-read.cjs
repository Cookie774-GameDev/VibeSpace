'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const prompt = 'Use the connected Blender MCP server for one read-only query: call its scene-information or object-listing tool once, then report the tool name and how many objects it returned. Do not create, edit, delete, save, run shell commands, or use VibeSpace custom mcp_list/mcp_run. If no read-only Blender MCP tool is available, say unavailable.';
const promptSha256 = crypto.createHash('sha256').update(prompt).digest('hex');
const guardPath = path.join(__dirname, 'opencode-mcp-read-send-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, promptSha256, stage: 'attach',
  providerSendAttempted: false, expectedBackend: 'opencode', expectedModel: 'openai/gpt-6-luna' };
let browser;
function check(ok, code) { if (!ok) throw new Error(code); }
async function snapshot(page) {
  return page.evaluate(async id => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const selection = useAuthStore.getState().chatModelSelection;
    return { activeChatId: useUIStore.getState().activeChatId,
      projectId: chat?.project_id ?? null, backend: chat?.backend_affinity?.backend ?? null,
      selection: selection?.mode === 'single' ? { connectionId: selection.connectionId,
        modelId: selection.modelId } : null,
      status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draftLength: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value?.length ?? null,
      userCount: rows.filter(row => row.role === 'user').length,
      assistantCount: rows.filter(row => row.role === 'assistant').length,
      messages: rows.map(row => ({ id: row.id, role: row.role,
        text: (row.parts ?? []).filter(part => part.kind === 'text')
          .map(part => part.text).join('\n').slice(0, 260),
        toolParts: (row.parts ?? []).filter(part => part.kind === 'tool_call' || part.kind === 'tool_result')
          .map(part => ({ kind: part.kind, name: part.tool ?? part.name ?? part.tool_name ?? null,
            callId: part.callId ?? part.call_id ?? null, status: part.status ?? part.result?.status ?? null })),
        errors: (row.parts ?? []).filter(part => part.kind === 'provider_error')
          .map(part => ({ code: part.error?.code ?? null,
            message: String(part.error?.message ?? '').slice(0, 180) })) })),
      pendingPermissions: rows.flatMap(row => row.parts ?? []).filter(part =>
        part.kind === 'permission_request' && part.request?.status === 'pending').length,
    };
  }, chatId);
}
(async () => {
  check(!fs.existsSync(guardPath), 'mcp_read_send_guard_exists_reconcile_only');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  check(main.length === 1, 'exact_official_main_required');
  const page = main[0].page;
  const before = await snapshot(page);
  receipt.before = { ...before, messages: before.messages.map(row => ({ id: row.id, role: row.role })) };
  check(before.activeChatId === chatId && before.projectId === 'prj_ybjv0yXnrGkGhAQY' &&
    before.backend === 'opencode' && before.selection?.connectionId === 'opencode-cli' &&
    before.selection?.modelId === 'openai/gpt-6-luna' && before.status === 'Complete' &&
    before.draftLength === 0 && before.pendingPermissions === 0 &&
    before.userCount === 5 && before.assistantCount === 8,
  'exact_idle_opencode_luna_chat_required');
  const input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
  receipt.stage = 'prepare-send';
  await input.fill(prompt, { timeout: 10000 });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  check(await send.count() === 1 && await send.isEnabled(), 'native_send_unavailable');
  fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256, beforeIds: before.messages.map(row => row.id), status: 'before-send' }, null, 2) + '\n', { flag: 'wx' });
  receipt.providerSendAttempted = true;
  await send.click({ timeout: 10000 });
  receipt.stage = 'observe';
  const deadline = Date.now() + 120000;
  let current;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    current = await snapshot(page);
    if (current.activeChatId !== chatId) throw new Error('chat_switched_during_mcp_turn');
    const fresh = current.messages.filter(row => !before.messages.some(old => old.id === row.id));
    if (current.pendingPermissions > 0 ||
      (fresh.some(row => row.role === 'user') && ['Complete', 'Failed', 'Cancelled'].includes(current.status))) break;
  }
  receipt.after = current && { ...current,
    messages: current.messages.filter(row => !before.messages.some(old => old.id === row.id)) };
  const fresh = receipt.after?.messages ?? [];
  receipt.mcpToolCalls = fresh.flatMap(row => row.toolParts)
    .filter(part => part.kind === 'tool_call' && /^(mcp__|mcp\.)/i.test(part.name ?? ''));
  receipt.passed = Boolean(receipt.after?.status === 'Complete' &&
    receipt.after.userCount === before.userCount + 1 &&
    receipt.after.pendingPermissions === 0 && receipt.mcpToolCalls.length === 1 &&
    /^mcp__blender__/i.test(receipt.mcpToolCalls[0].name ?? ''));
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-mcp-read-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      status: receipt.after?.status, mcpToolCalls: receipt.mcpToolCalls, failure: receipt.failure }));
    if (browser) await browser.close();
  });
