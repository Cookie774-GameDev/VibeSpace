import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, resolve } from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayMcpServer } from '@relaycast/mcp';
import { startRelayRuntime } from './relay-runtime.mjs';

const DEFAULT_CHANNEL = 'vibespace';
const ROOM_MESSAGE_LIMIT = 30;
const ROOM_THREAD_PARENT_LIMIT = 8;
const ALLOWED_TOOLS = new Set([
  'agent.list',
  'channel.list',
  'channel.join',
  'message.inbox.check',
  'message.inbox.mark_read',
  'message.list',
  'message.get_thread',
  'message.post',
  'message.reply',
  'message.dm.send',
]);
const NO_TELEMETRY = Object.freeze({ capture() {}, async flush() {} });

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: run.mjs --data-dir <absolute-profile-directory>');
  }
  if (!isAbsolute(args[1])) throw new Error('Profile directory must be absolute');
  return resolve(args[1]);
}

async function loadOrCreateSecret(path) {
  try {
    const value = await readFile(path, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid persisted file signing key');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      return value;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      const raced = await readFile(path, 'utf8');
      if (!/^[a-f0-9]{64}$/.test(raced)) throw new Error('Invalid persisted file signing key');
      return raced;
    }
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

const dataDir = parseArgs(process.argv.slice(2));
await mkdir(dataDir, { recursive: true });
const statusPath = join(dataDir, 'engine-status.json');
const portPath = join(dataDir, 'engine-port.json');
let port = 0;
try {
  const saved = JSON.parse(await readFile(portPath, 'utf8'));
  if (!Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) throw new Error('Invalid persisted Relay port');
  port = saved.port;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const fileDir = join(dataDir, 'files');
await mkdir(fileDir, { recursive: true });
const fileSecret = await loadOrCreateSecret(join(dataDir, '.file-signing-key'));
const host = await startRelayRuntime({ dbPath: join(dataDir, 'relay.sqlite'), fileDir, fileSecret, port });
await atomicJson(portPath, { version: 1, port: host.port });
await atomicJson(statusPath, { version: 1, state: 'running', host: host.host, port: host.port, baseUrl: host.baseUrl, pid: process.pid });
console.log(JSON.stringify({ event: 'ready', baseUrl: host.baseUrl, pid: process.pid }));

const bindings = new Map();
function requireRecord(value, message = 'Invalid Relay request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function requireText(value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error('Invalid Relay request');
  }
  return value.trim();
}

function assertKeys(value, required, optional = []) {
  requireRecord(value);
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key))) {
    throw new Error('Invalid Relay request');
  }
}

function assertMcpSuccess(result) {
  if (result?.isError === true) throw new Error('Relaycast MCP operation failed');
  return result;
}

function mcpData(result, key) {
  const value = assertMcpSuccess(result)?.structuredContent?.[key];
  if (!Array.isArray(value)) throw new Error('Relaycast MCP response is unavailable');
  return value;
}

function displayText(value, max, fallback = '') {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function sanitizeRoomMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !message.id.trim()) {
    throw new Error('Relaycast message response is invalid');
  }
  const replyCount = Number.isFinite(message.replyCount) ? Math.max(0, Math.min(1_000_000, Math.trunc(message.replyCount))) : 0;
  return {
    id: message.id.slice(0, 256),
    text: displayText(message.text, 8192),
    authorId: displayText(message.agentId, 256),
    authorName: displayText(message.agentName, 100),
    createdAt: displayText(message.createdAt, 80),
    parentId: typeof message.threadId === 'string' ? message.threadId.slice(0, 256) : null,
    replyCount,
  };
}

async function expandRoomMessages(binding, upstreamMessages) {
  const timeline = new Map();
  for (const message of upstreamMessages) {
    const sanitized = sanitizeRoomMessage(message);
    timeline.set(sanitized.id, sanitized);
  }

  const parents = upstreamMessages
    .filter((message) => Number.isFinite(message?.replyCount) && message.replyCount > 0)
    .slice(0, ROOM_THREAD_PARENT_LIMIT);
  for (const parent of parents) {
    try {
      const parentId = requireText(parent.id, 256);
      const replyLimit = Math.min(ROOM_MESSAGE_LIMIT, Math.max(1, Math.trunc(parent.replyCount)));
      const thread = assertMcpSuccess(await binding.client.callTool({
        name: 'message.get_thread',
        arguments: { message_id: parentId, limit: replyLimit },
      }))?.structuredContent;
      if (thread?.parent?.id !== parentId || !Array.isArray(thread.replies)) continue;
      const replies = thread.replies
        .slice(-replyLimit)
        .filter((reply) => reply?.id !== parentId)
        .map((reply) => {
          if (typeof reply?.threadId === 'string' && reply.threadId !== parentId) {
            throw new Error('Relaycast thread reply has an invalid parent');
          }
          return sanitizeRoomMessage({ ...reply, threadId: parentId });
        });
      for (const reply of replies) timeline.set(reply.id, reply);
    } catch {
      // Keep the already-sanitized channel parent when thread retrieval fails.
    }
  }

  const timestamp = (message) => {
    const value = Date.parse(message.createdAt);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return [...timeline.values()]
    .sort((left, right) => timestamp(left) - timestamp(right) || left.id.localeCompare(right.id))
    .slice(-ROOM_MESSAGE_LIMIT);
}

function sanitizeRoomParticipant(agent) {
  if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || !agent.id.trim()
      || typeof agent.name !== 'string' || !agent.name.trim()) {
    throw new Error('Relaycast participant response is invalid');
  }
  return {
    id: agent.id.slice(0, 256),
    name: agent.name.slice(0, 100),
    role: ['agent', 'human', 'system'].includes(agent.type) ? agent.type : 'system',
    status: ['online', 'offline', 'away'].includes(agent.status) ? agent.status : 'unknown',
    persona: displayText(agent.persona, 500),
  };
}

function requireHumanBinding(binding) {
  if (!binding) throw new Error('Relay participant binding expired');
  if (binding.role !== 'human') throw new Error('Relay human operation requires a human binding');
  return binding;
}

function requireHumanMessageText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) {
    throw new Error('Invalid Relay message');
  }
  return value.trim();
}

function messageAcknowledgement(result, threadId = null) {
  const message = assertMcpSuccess(result)?.structuredContent;
  if (!message || typeof message.id !== 'string' || !message.id.trim()) {
    throw new Error('Relaycast message response is invalid');
  }
  return {
    messageId: message.id.slice(0, 256),
    threadId: typeof threadId === 'string'
      ? threadId.slice(0, 256)
      : typeof message.threadId === 'string' ? message.threadId.slice(0, 256) : null,
  };
}

async function connectMcpParticipant({ workspaceKey, agentToken, agentName, role }) {
  const server = createRelayMcpServer({
    apiKey: workspaceKey,
    baseUrl: host.baseUrl,
    agentToken,
    agentName,
    agentType: role,
    strictAgentName: true,
    telemetryTransport: 'stdio',
    telemetry: NO_TELEMETRY,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vibespace-relay-host', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  } catch (error) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
}

async function closeBinding(binding) {
  await binding.client.close().catch(() => {});
  await binding.server.close().catch(() => {});
}

async function ensureDefaultChannel(client) {
  const result = assertMcpSuccess(await client.callTool({ name: 'channel.list', arguments: {} }));
  const channels = result.structuredContent?.channels;
  if (!Array.isArray(channels)) throw new Error('Relaycast channel list is unavailable');
  if (!channels.some((channel) => channel?.name === DEFAULT_CHANNEL)) {
    assertMcpSuccess(await client.callTool({
      name: 'channel.create',
      arguments: { name: DEFAULT_CHANNEL, topic: 'VibeSpace agent coordination' },
    }));
  }
  assertMcpSuccess(await client.callTool({ name: 'channel.join', arguments: { channel: DEFAULT_CHANNEL } }));
}

async function hostOperation(request) {
  assertKeys(request, ['id', 'method', 'params']);
  requireText(request.id, 80);
  const params = requireRecord(request.params);
  if (request.method === 'workspace.create') {
    assertKeys(params, ['name']);
    const relay = await AgentRelay.createWorkspace({ name: requireText(params.name, 120), baseUrl: host.baseUrl });
    const workspace = await relay.workspace.info();
    return { workspaceId: workspace.id, workspaceKey: relay.workspaceKey };
  }
  if (request.method === 'participant.bind') {
    assertKeys(params, ['bindingId', 'workspaceKey', 'agentName', 'role'], ['agentToken']);
    const bindingId = requireText(params.bindingId, 96);
    if (bindings.has(bindingId)) throw new Error('Relay participant binding already exists');
    const workspaceKey = requireText(params.workspaceKey, 512);
    const agentName = requireText(params.agentName, 100);
    if (!['agent', 'human'].includes(params.role)) throw new Error('Invalid Relay role');
    const relay = new AgentRelay({ workspaceKey, baseUrl: host.baseUrl });
    const agent = params.agentToken
      ? await relay.workspace.reconnect({ apiToken: requireText(params.agentToken, 512) })
      : await relay.workspace.register({ name: agentName, type: params.role }, { strict: true });
    if (!agent?.id || !agent?.token) throw new Error('Relay participant registration failed');
    const mcp = await connectMcpParticipant({
      workspaceKey,
      agentToken: agent.token,
      agentName,
      role: params.role,
    });
    try {
      await ensureDefaultChannel(mcp.client);
    } catch (error) {
      await closeBinding(mcp);
      throw error;
    }
    bindings.set(bindingId, {
      ...mcp,
      workspaceKey,
      workspaceId: (await relay.workspace.info()).id,
      agentId: agent.id,
      agentName,
      agentToken: agent.token,
      role: params.role,
    });
    return {
      bindingId,
      workspaceId: (await relay.workspace.info()).id,
      participantId: agent.id,
      agentName,
      agentToken: agent.token,
      channelName: DEFAULT_CHANNEL,
    };
  }
  if (request.method === 'participant.unbind') {
    assertKeys(params, ['bindingId']);
    const bindingId = requireText(params.bindingId, 96);
    const binding = bindings.get(bindingId);
    if (binding) {
      bindings.delete(bindingId);
      await closeBinding(binding);
    }
    return { unbound: true };
  }
  if (request.method === 'participant.rotate') {
    assertKeys(params, ['workspaceKey', 'agentName', 'role']);
    const relay = new AgentRelay({
      workspaceKey: requireText(params.workspaceKey, 512),
      baseUrl: host.baseUrl,
    });
    if (!['agent', 'human'].includes(params.role)) throw new Error('Invalid Relay role');
    const agent = await relay.workspace.register({
      name: requireText(params.agentName, 100),
      type: params.role,
    });
    if (!agent?.id || !agent?.token) throw new Error('Relay participant rotation failed');
    return { participantId: agent.id, agentToken: agent.token };
  }
  if (request.method === 'tools.list') {
    assertKeys(params, ['bindingId']);
    const binding = bindings.get(requireText(params.bindingId, 96));
    if (!binding) throw new Error('Relay participant binding expired');
    if (binding.role !== 'agent') throw new Error('Generic Relay tools require an agent binding');
    const { tools } = await binding.client.listTools();
    return {
      tools: tools.filter((tool) => ALLOWED_TOOLS.has(tool.name)).map((tool) => {
        const inputSchema = structuredClone(tool.inputSchema);
        for (const key of ['as', 'workspace_id', 'workspace_alias']) delete inputSchema.properties?.[key];
        if (Array.isArray(inputSchema.required)) {
          inputSchema.required = inputSchema.required.filter((key) => !['as', 'workspace_id', 'workspace_alias'].includes(key));
        }
        return {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema,
          annotations: tool.annotations,
        };
      }),
    };
  }
  if (request.method === 'tools.call') {
    assertKeys(params, ['bindingId', 'name', 'arguments']);
    const binding = bindings.get(requireText(params.bindingId, 96));
    if (!binding) throw new Error('Relay participant binding expired');
    if (binding.role !== 'agent') throw new Error('Generic Relay tools require an agent binding');
    const name = requireText(params.name, 120);
    if (!ALLOWED_TOOLS.has(name)) throw new Error('Relay tool is not allowed');
    const args = requireRecord(params.arguments);
    if (['as', 'workspace_id', 'workspace_alias'].some((key) => key in args)) {
      throw new Error('Relay identity and workspace routing overrides are disabled');
    }
    return await binding.client.callTool({ name, arguments: args });
  }
  if (request.method === 'human.room_snapshot') {
    assertKeys(params, ['bindingId', 'limit']);
    const binding = requireHumanBinding(bindings.get(requireText(params.bindingId, 96)));
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50) {
      throw new Error('Invalid Relay room limit');
    }
    const upstreamMessages = mcpData(await binding.client.callTool({
      name: 'message.list',
      arguments: { channel: DEFAULT_CHANNEL, limit: Math.min(params.limit, ROOM_MESSAGE_LIMIT) },
    }), 'messages').slice(0, ROOM_MESSAGE_LIMIT);
    const messages = await expandRoomMessages(binding, upstreamMessages);
    const participants = mcpData(await binding.client.callTool({
      name: 'agent.list',
      arguments: {},
    }), 'agents').slice(0, 100).map(sanitizeRoomParticipant);
    return { channel: DEFAULT_CHANNEL, messages, participants };
  }
  if (request.method === 'human.message') {
    assertKeys(params, ['bindingId', 'text'], ['parentMessageId']);
    const binding = requireHumanBinding(bindings.get(requireText(params.bindingId, 96)));
    const text = requireHumanMessageText(params.text);
    const parentMessageId = params.parentMessageId == null
      ? null
      : requireText(params.parentMessageId, 256);
    if (parentMessageId) {
      const channels = mcpData(await binding.client.callTool({
        name: 'channel.list',
        arguments: {},
      }), 'channels');
      const targetChannel = channels.find((channel) => channel?.name === DEFAULT_CHANNEL);
      if (!targetChannel || typeof targetChannel.id !== 'string') {
        throw new Error('VibeSpace Relay channel is unavailable');
      }
      const thread = assertMcpSuccess(await binding.client.callTool({
        name: 'message.get_thread',
        arguments: { message_id: parentMessageId },
      }))?.structuredContent;
      if (thread?.parent?.channelId !== targetChannel.id) {
        throw new Error('Relay replies are limited to the VibeSpace channel');
      }
      return messageAcknowledgement(await binding.client.callTool({
        name: 'message.reply',
        arguments: { message_id: parentMessageId, text },
      }), parentMessageId);
    }
    return messageAcknowledgement(await binding.client.callTool({
      name: 'message.post',
      arguments: { channel: DEFAULT_CHANNEL, text },
    }));
  }
  throw new Error('Unknown Relay host operation');
}

const testCredentialsPath = join(dataDir, '.test-acceptance-credentials.json');
async function testOperation(request) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Runner operations are disabled');
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).sort().join(',') !== 'id,method'
      || typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 80) {
    throw new Error('Invalid test operation');
  }
  if (request.method === 'acceptance.bootstrap') {
    try { await readFile(testCredentialsPath); throw new Error('Acceptance already bootstrapped'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const suffix = randomBytes(8).toString('hex');
    const relay = await AgentRelay.createWorkspace({ name: `runner-accept-${suffix}`, baseUrl: host.baseUrl });
    const workspace = await relay.workspace.info();
    const [alpha, beta] = await relay.workspace.register([
      { name: `runner-alpha-${suffix}`, type: 'agent' },
      { name: `runner-beta-${suffix}`, type: 'agent' },
    ], { strict: true });
    const channelName = `runner-accept-${suffix}`;
    await alpha.channels.create({ name: channelName, topic: 'isolated runner acceptance' });
    await alpha.channels.join(channelName);
    await beta.channels.join(channelName);
    const channel = await alpha.channels.get(channelName);
    const memberIds = new Set(channel.members.map((member) => member.agentId ?? member.agent_id));
    if (!memberIds.has(alpha.id) || !memberIds.has(beta.id) || alpha.id === beta.id) throw new Error('Authenticated channel membership failed');
    const parentText = `parent ${suffix}`;
    const replyText = `reply ${suffix}`;
    const parent = await alpha.sendMessage({ to: `#${channelName}`, text: parentText });
    const reply = await beta.reply({ messageId: parent.messageId, text: replyText });
    if (parent.from?.id !== alpha.id || reply.from?.id !== beta.id || reply.parentId !== parent.messageId) {
      throw new Error('Authenticated exchange validation failed');
    }
    const privateRecord = {
      version: 1, baseUrl: host.baseUrl, workspaceId: workspace.id,
      workspaceKey: relay.workspaceKey, alphaToken: alpha.token, betaToken: beta.token,
      alphaId: alpha.id, betaId: beta.id, parentId: parent.messageId,
      parentText, replyId: reply.messageId, replyText,
    };
    const handle = await open(testCredentialsPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(privateRecord), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return { status: 'passed', workspaceId: workspace.id, participantIds: [alpha.id, beta.id], channelId: channel.id, parentId: parent.messageId, replyId: reply.messageId, sourceIds: [parent.from.id, reply.from.id], persistence: 'pending-restart' };
  }
  if (request.method === 'acceptance.verifyRestart') {
    const saved = JSON.parse(await readFile(testCredentialsPath, 'utf8'));
    const relay = new AgentRelay({ workspaceKey: saved.workspaceKey, baseUrl: host.baseUrl });
    const workspace = await relay.workspace.info();
    const alpha = await relay.workspace.reconnect({ apiToken: saved.alphaToken });
    const beta = await relay.workspace.reconnect({ apiToken: saved.betaToken });
    const thread = await relay.threads.get(saved.parentId, { limit: 20 });
    const parent = thread.parent;
    const reply = thread.replies.find((item) => item.id === saved.replyId);
    if (workspace.id !== saved.workspaceId || alpha.id !== saved.alphaId || beta.id !== saved.betaId
        || parent.from?.id !== alpha.id || parent.text !== saved.parentText
        || !reply || reply.from?.id !== beta.id || reply.text !== saved.replyText || reply.parentId !== parent.id) {
      throw new Error('Persisted authenticated thread validation failed');
    }
    return { status: 'passed', workspaceId: workspace.id, participantIds: [alpha.id, beta.id], parentId: parent.id, replyId: reply.id, sourceIds: [parent.from.id, reply.from.id], persistence: 'verified-after-supervisor-restart' };
  }
  throw new Error('Unknown test operation');
}

let stopping;
const stop = () => stopping ??= (async () => {
  await Promise.all([...bindings.values()].map(closeBinding));
  bindings.clear();
  await host.stop();
  await rm(statusPath, { force: true });
})();
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line === 'stop') { await stop(); process.exit(0); }
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const result = request?.method?.startsWith('acceptance.')
      ? await testOperation(request)
      : await hostOperation(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    const id = request && typeof request.id === 'string' ? request.id : null;
    process.stdout.write(`${JSON.stringify({ id, error: 'Relay operation rejected' })}\n`);
  }
}
await stop();
