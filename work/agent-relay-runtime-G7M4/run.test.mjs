import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { runProductionRunnerAcceptance } from './production-runner-acceptance.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const runner = resolve(here, 'run.mjs');

function waitForReady(child, timeoutMs = 20_000) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay runner readiness timed out')), timeoutMs);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'ready') { clearTimeout(timer); resolveReady(event); }
        } catch { /* ignore incomplete or non-JSON stdout */ }
      }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Relay runner exited (${code}): ${stderr}`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function spawnRunner(dataDir) {
  return spawn(process.execPath, [runner, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function stop(child) {
  return new Promise((resolveStop, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Relay runner stop timed out')); }, 8000);
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolveStop(); else reject(new Error(`Relay runner exited with ${code}`)); });
    child.stdin.end('stop\n');
  });
}

function spawnRpcRunner(dataDir) {
  const child = spawn(process.execPath, [runner, '--data-dir', dataDir], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') { readyResolve(message); return; }
    if (typeof message.id !== 'string') return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  child.once('error', readyReject);
  child.once('exit', (code) => {
    const error = new Error(`Relay runner exited (${code})`);
    readyReject(error);
    for (const resolve of pending.values()) resolve({ error: error.message });
    pending.clear();
  });
  return {
    child,
    ready,
    request(method, params = {}) {
      const id = randomUUID();
      return new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectResult(new Error(`Relay ${method} timed out`));
        }, 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          message.error ? rejectResult(new Error(message.error)) : resolveResult(message.result);
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin.write('stop\n');
      await new Promise((resolveExit, rejectExit) => {
        const timer = setTimeout(() => { child.kill(); rejectExit(new Error('Relay runner stop timed out')); }, 8000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          code === 0 ? resolveExit() : rejectExit(new Error(`Relay runner stop exited (${code})`));
        });
      });
    },
  };
}

function structured(result) {
  assert.notEqual(result?.isError, true, result?.content?.map((item) => item.text).join('\n'));
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

test('runner accepts only a fixed data-directory interface', async () => {
  const child = spawn(process.execPath, [runner, '--db', 'arbitrary.sqlite'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  assert.notEqual(exit, 0);
});

test('runner persists profile signing key and stable loopback port through stop/restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibespace-relay-runner-'));
  let child;
  try {
    child = spawnRunner(dataDir);
    const first = await waitForReady(child);
    assert.match(first.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const firstPort = Number(new URL(first.baseUrl).port);
    const key = await readFile(join(dataDir, '.file-signing-key'), 'utf8');
    assert.match(key, /^[a-f0-9]{64}$/);
    await stop(child);
    child = undefined;

    child = spawnRunner(dataDir);
    const second = await waitForReady(child);
    assert.equal(Number(new URL(second.baseUrl).port), firstPort);
    assert.equal(await readFile(join(dataDir, '.file-signing-key'), 'utf8'), key);
    const health = await fetch(`${second.baseUrl}/health`);
    assert.equal(health.status, 200);
    await stop(child);
    child = undefined;
  } finally {
    if (child?.exitCode === null) { child.kill(); await new Promise((resolveExit) => child.once('exit', resolveExit)); }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('production runner rejects SDK acceptance operations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibespace-relay-production-denial-'));
  const child = spawn(process.execPath, [runner, '--data-dir', dataDir], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let ready = false;
  let resultResolve;
  const result = new Promise((resolveResult) => { resultResolve = resolveResult; });
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      if (value.event === 'ready') ready = true;
      else if (value.id === 'production-denial') resultResolve(value);
    } catch { /* ignore non-protocol output */ }
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Runner readiness timed out')), 20_000);
      lines.on('line', () => { if (ready) { clearTimeout(timer); resolveReady(); } });
      child.once('error', rejectReady);
      child.once('exit', (code) => { clearTimeout(timer); rejectReady(new Error(`Runner exited (${code})`)); });
    });
    child.stdin.write('{"id":"production-denial","method":"acceptance.bootstrap"}\n');
    const response = await Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Runner denial timed out')), 5000)),
    ]);
    assert.equal(response.error, 'Relay operation rejected');
    assert.equal(response.result, undefined);
    child.stdin.write('stop\n');
    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('Runner stop timed out')), 8000);
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveExit() : rejectExit(new Error(`Runner stop exited (${code})`)); });
    });
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((resolveExit) => child.once('exit', resolveExit)); }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('host RPC registers scoped SDK participants and exposes only allowlisted upstream MCP tools', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibespace-relay-mcp-host-'));
  let runnerClient;
  try {
    runnerClient = spawnRpcRunner(dataDir);
    const firstReady = await runnerClient.ready;
    assert.match(firstReady.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const workspace = await runnerClient.request('workspace.create', { name: `host-${randomUUID()}` });
    assert.ok(workspace.workspaceId);
    assert.ok(workspace.workspaceKey);
    const bind = async (agentName) => runnerClient.request('participant.bind', {
      bindingId: randomUUID(),
      workspaceKey: workspace.workspaceKey,
      agentName,
      role: 'agent',
    });
    const alpha = await bind(`alpha-${randomUUID()}`);
    const beta = await bind(`beta-${randomUUID()}`);
    const human = await runnerClient.request('participant.bind', {
      bindingId: randomUUID(),
      workspaceKey: workspace.workspaceKey,
      agentName: `human-${randomUUID()}`,
      role: 'human',
    });
    assert.notEqual(alpha.participantId, beta.participantId);
    assert.ok(alpha.agentToken);
    assert.ok(beta.agentToken);
    assert.ok(human.agentToken);

    const catalog = await runnerClient.request('tools.list', { bindingId: alpha.bindingId });
    const names = catalog.tools.map((tool) => tool.name);
    for (const name of [
      'agent.list', 'channel.list', 'channel.join', 'message.inbox.check',
      'message.inbox.mark_read', 'message.list', 'message.get_thread',
      'message.post', 'message.reply', 'message.dm.send',
    ]) assert.ok(names.includes(name), `missing upstream MCP tool ${name}`);
    for (const name of ['agent.register', 'workspace.create', 'workspace.switch', 'channel.create']) {
      assert.ok(!names.includes(name), `unsafe upstream MCP tool leaked: ${name}`);
    }

    const unique = randomUUID();
    const post = structured(await runnerClient.request('tools.call', {
      bindingId: alpha.bindingId,
      name: 'message.post',
      arguments: { channel: 'vibespace', text: `relay-host-${unique}` },
    }));
    const parentId = post.messageId ?? post.id;
    assert.ok(parentId);
    const room = await runnerClient.request('human.room_snapshot', {
      bindingId: human.bindingId,
      limit: 5,
    });
    assert.deepEqual(Object.keys(room).sort(), ['channel', 'messages', 'participants']);
    assert.equal(room.channel, 'vibespace');
    assert.ok(room.messages.length <= 5);
    assert.ok(room.messages.some((message) => message.id === parentId && message.text === `relay-host-${unique}`));
    assert.ok(room.participants.some((participant) => participant.id === alpha.participantId && participant.role === 'agent'));
    assert.ok(room.participants.some((participant) => participant.id === human.participantId && participant.role === 'human'));
    for (const message of room.messages) {
      assert.deepEqual(Object.keys(message).sort(), ['authorId', 'authorName', 'createdAt', 'id', 'parentId', 'replyCount', 'text']);
    }
    for (const participant of room.participants) {
      assert.deepEqual(Object.keys(participant).sort(), ['id', 'name', 'persona', 'role', 'status']);
    }
    await assert.rejects(
      runnerClient.request('human.room_snapshot', { bindingId: alpha.bindingId, limit: 5 }),
      /Relay operation rejected/,
    );
    await assert.rejects(
      runnerClient.request('tools.list', { bindingId: human.bindingId }),
      /Relay operation rejected/,
    );
    await assert.rejects(
      runnerClient.request('tools.call', { bindingId: human.bindingId, name: 'agent.list', arguments: {} }),
      /Relay operation rejected/,
    );
    const humanPost = await runnerClient.request('human.message', {
      bindingId: human.bindingId,
      text: `human-${unique}`,
    });
    assert.ok(humanPost.messageId);
    assert.equal(humanPost.threadId, null);
    assert.equal(Object.hasOwn(humanPost, 'agentToken'), false);
    const humanReply = await runnerClient.request('human.message', {
      bindingId: human.bindingId,
      text: `human-reply-${unique}`,
      parentMessageId: parentId,
    });
    assert.notEqual(humanReply.messageId, parentId);
    assert.equal(humanReply.threadId, parentId);
    await assert.rejects(
      runnerClient.request('human.message', { bindingId: alpha.bindingId, text: 'forbidden' }),
      /Relay operation rejected/,
    );
    const reply = structured(await runnerClient.request('tools.call', {
      bindingId: beta.bindingId,
      name: 'message.reply',
      arguments: { message_id: parentId, text: `reply-${unique}` },
    }));
    assert.equal(reply.agentId, beta.participantId);
    assert.equal(reply.threadId, parentId);
    const thread = structured(await runnerClient.request('tools.call', {
      bindingId: alpha.bindingId,
      name: 'message.get_thread',
      arguments: { message_id: parentId },
    }));
    assert.ok(thread?.parent, JSON.stringify(thread));
    assert.equal(thread.parent.id, parentId);
    assert.ok(thread.replies.some((item) => item.agentId === human.participantId && item.text === `human-reply-${unique}`));
    assert.equal(thread.replies.at(-1).agentId, beta.participantId);
    const expandedRoom = await runnerClient.request('human.room_snapshot', {
      bindingId: human.bindingId,
      limit: 5,
    });
    const timeline = expandedRoom.messages;
    const timelineIds = timeline.map((item) => item.id);
    assert.ok(timeline.length <= 30);
    assert.equal(new Set(timelineIds).size, timelineIds.length);
    assert.equal(timeline.filter((item) => item.id === parentId).length, 1);
    assert.equal(timeline.find((item) => item.id === humanReply.messageId)?.parentId, parentId);
    const betaReplyId = reply.messageId ?? reply.id;
    assert.equal(timeline.find((item) => item.id === betaReplyId)?.parentId, parentId);
    const timelineTimes = timeline.map((item) => Date.parse(item.createdAt));
    assert.ok(timelineTimes.every(Number.isFinite));
    assert.deepEqual(timelineTimes, [...timelineTimes].sort((a, b) => a - b));
    await runnerClient.request('tools.call', {
      bindingId: beta.bindingId,
      name: 'message.inbox.mark_read',
      arguments: { message_id: parentId },
    });
    await assert.rejects(
      runnerClient.request('tools.call', { bindingId: alpha.bindingId, name: 'workspace.switch', arguments: {} }),
      /Relay operation rejected/,
    );
    await runnerClient.stop();
    runnerClient = undefined;

    runnerClient = spawnRpcRunner(dataDir);
    const secondReady = await runnerClient.ready;
    assert.equal(secondReady.baseUrl, firstReady.baseUrl);
    const alphaAfterRestart = await runnerClient.request('participant.bind', {
      bindingId: randomUUID(), workspaceKey: workspace.workspaceKey,
      agentToken: alpha.agentToken, agentName: alpha.agentName, role: 'agent',
    });
    assert.equal(alphaAfterRestart.participantId, alpha.participantId);
    const persisted = structured(await runnerClient.request('tools.call', {
      bindingId: alphaAfterRestart.bindingId,
      name: 'message.get_thread',
      arguments: { message_id: parentId },
    }));
    assert.equal(persisted.replies.at(-1).id, reply.id);
  } finally {
    await runnerClient?.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('packaged runner exchanges real authenticated SDK messages and resumes them after supervisor restart', async () => {
  const receipt = await runProductionRunnerAcceptance();
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.endpoint, '127.0.0.1');
  assert.equal(receipt.participantIds.length, 2);
  assert.notEqual(receipt.participantIds[0], receipt.participantIds[1]);
  assert.ok(receipt.parentId);
  assert.ok(receipt.replyId);
  assert.equal(receipt.persistence, 'verified-after-supervisor-restart');
});
