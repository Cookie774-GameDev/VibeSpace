import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpServerManager } from './serverManager'
import {
  createMcpSdkClientAdapter,
  createMcpCancellationFetch,
  type McpSdkClientPort,
} from './mcpSdkClientAdapter'

function harness() {
  const calls: string[] = []
  const client: McpSdkClientPort = {
    connect: vi.fn(async () => { calls.push('connect') }),
    close: vi.fn(async () => { calls.push('close') }),
    ping: vi.fn(async () => ({})),
    listTools: vi.fn(async (params) => ({
      tools: params?.cursor
        ? [{ name: 'remove', description: 'Remove', inputSchema: {}, annotations: { destructiveHint: true } }]
        : [{ name: 'read', description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      nextCursor: params?.cursor ? undefined : 'next',
    })),
    listResources: vi.fn(async () => ({
      resources: [{ uri: 'memory://one', name: 'Memory', mimeType: 'text/plain' }],
    })),
    listPrompts: vi.fn(async () => ({
      prompts: [{ name: 'summarize', arguments: [{ name: 'topic', required: true }] }],
    })),
    callTool: vi.fn(async (_params, _schema, options) => {
      options?.onprogress?.({ progress: 1, total: 2, message: 'working' })
      return { content: [{ type: 'text', text: 'ok' }] }
    }),
  }
  const adapter = createMcpSdkClientAdapter({
    id: 'remote',
    endpoint: 'https://mcp.example.test/mcp',
    clientFactory: () => client,
    transportFactory: () => ({}) as Transport,
  })
  return { adapter, client, calls }
}

describe('MCP SDK client adapter', () => {
  it.each([
    ['omitted', undefined, true, true],
    ['null', null, false, false],
    ['nonstring', 42, false, false],
    ['empty', '', true, false],
    ['whitespace', '  \n ', true, false],
    ['valid', 'Read synthetic fixture', true, true],
  ] as const)('P03 preserves manager description policy for %s metadata', async (
    _label, description, protocolValid, discoveryValid,
  ) => {
    const descriptor = {
      name: 'fixture.read',
      ...(description === undefined ? {} : { description }),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }
    // Null/nonstring metadata would be rejected by the installed SDK itself;
    // the injected port also proves the manager remains fail-closed beneath it.
    expect(ListToolsResultSchema.safeParse({ tools: [descriptor] }).success).toBe(protocolValid)
    const { adapter, client } = harness()
    vi.mocked(client.listTools).mockResolvedValue({ tools: [descriptor] })
    const manager = new McpServerManager()
    manager.register(adapter, { kind: 'external_mcp', exposure: { mode: 'none' } })
    try {
      if (discoveryValid) {
        const tools = await manager.listTools(adapter.id)
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({
          name: 'fixture.read',
          description: description === undefined ? 'No description provided.' : description,
        })
      } else {
        await expect(manager.listTools(adapter.id)).rejects.toThrow('Invalid MCP tool description.')
      }
      expect(manager.status(adapter.id).exposedTools).toEqual([])
      expect(client.callTool).not.toHaveBeenCalled()
    } finally {
      await manager.stopAll()
    }
  })

  it('rejects a POST cancelled before transport headers finish preparing it', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const send = createMcpCancellationFetch(base)
    await send('https://mcp.test', { body: JSON.stringify({ method: 'notifications/cancelled', params: { requestId: 7 } }) })
    await expect(send('https://mcp.test', { body: JSON.stringify({ id: 7, method: 'tools/call' }) }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('fails closed instead of evicting unresolved cancellation markers at capacity', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const send = createMcpCancellationFetch(base)
    for (let id = 0; id < 257; id += 1) {
      await send('https://mcp.test', { body: JSON.stringify({ method: 'notifications/cancelled', params: { requestId: id } }) })
    }
    await expect(send('https://mcp.test', { body: JSON.stringify({ id: 0, method: 'tools/call' }) })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(send('https://mcp.test', { body: JSON.stringify({ id: 257, method: 'tools/call' }) })).rejects.toMatchObject({ name: 'AbortError' })
    expect(base).toHaveBeenCalledTimes(257)
  })
  it('aborts only the cancelled HTTP request while still delivering its protocol notification', async () => {
    const signals = new Map<number, AbortSignal>()
    const notifications: unknown[] = []
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      const message = JSON.parse(String(init?.body))
      if (!('id' in message)) { notifications.push(message); return new Response(null, { status: 202 }) }
      signals.set(message.id, init!.signal!)
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
      })
    })
    const send = createMcpCancellationFetch(base)
    const transport = new AbortController()
    const first = send('https://mcp.test', { body: JSON.stringify({ id: 1, method: 'tools/call' }), signal: transport.signal })
    const second = send('https://mcp.test', { body: JSON.stringify({ id: 2, method: 'tools/call' }), signal: transport.signal })
    const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const secondResult = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await send('https://mcp.test', { body: JSON.stringify({ method: 'notifications/cancelled', params: { requestId: 1 } }) })
    await firstResult
    expect(signals.get(1)?.aborted).toBe(true)
    expect(signals.get(2)?.aborted).toBe(false)
    expect(notifications).toHaveLength(1)
    transport.abort()
    await secondResult
  })

  it('preserves streamed response data and cancels after HTTP headers arrive', async () => {
    let signal: AbortSignal | undefined
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      if (JSON.parse(String(init?.body)).method === 'notifications/cancelled') return new Response(null, { status: 202 })
      signal = init?.signal ?? undefined
      return new Response('streamed result', { headers: { 'content-type': 'application/json' } })
    })
    const send = createMcpCancellationFetch(base)
    const response = await send('https://mcp.test', { body: JSON.stringify({ id: 'request-1', method: 'tools/call' }) })
    await send('https://mcp.test', { body: JSON.stringify({ method: 'notifications/cancelled', params: { requestId: 'request-1' } }) })
    expect(signal?.aborted).toBe(true)
    expect(await response.text()).toBe('streamed result')
    expect(response.headers.get('content-type')).toBe('application/json')
  })
  it('does not downgrade destructive tools with contradictory read-only hints', async () => {
    const { adapter, client } = harness()
    vi.mocked(client.listTools).mockResolvedValue({
      tools: [{ name: 'contradictory', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: true } }],
    })
    const catalog = await adapter.getCatalog()
    expect(catalog.tools[0]?.classification).toBe('mutation')
  })

  it('connects lazily and discovers bounded tools, resources, and prompts', async () => {
    const { adapter, client, calls } = harness()
    expect(calls).toEqual([])

    const catalog = await adapter.getCatalog()

    expect(calls).toEqual(['connect'])
    expect(catalog.tools.map((tool) => [tool.name, tool.classification])).toEqual([
      ['read', 'read'],
      ['remove', 'mutation'],
    ])
    expect(catalog.resources[0]?.uri).toBe('memory://one')
    expect(catalog.prompts[0]?.arguments[0]?.name).toBe('topic')
    expect(catalog.schemaFingerprint).toMatch(/^mcp-sdk-v1:/)
    expect(client.listTools).toHaveBeenCalledTimes(2)
  })

  it('forwards cancellation and progress and closes the SDK session', async () => {
    const { adapter, client, calls } = harness()
    const server = await adapter.start()
    const controller = new AbortController()
    const onProgress = vi.fn()

    await expect(server.invoke('read', { query: 'safe' }, {
      signal: controller.signal,
      onProgress,
    })).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'read', arguments: { query: 'safe' } },
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    )
    expect(onProgress).toHaveBeenCalledWith({
      progress: 1,
      total: 2,
      message: 'working',
    })

    await server.stop()
    expect(calls).toEqual(['connect', 'close'])
  })

  it('fails closed on invalid endpoints and non-object arguments', async () => {
    expect(() => createMcpSdkClientAdapter({
      id: 'remote',
      endpoint: 'file:///tmp/socket',
    })).toThrow('HTTP(S)')
    expect(() => createMcpSdkClientAdapter({
      id: 'remote',
      endpoint: 'http://mcp.example.test/mcp',
    })).toThrow('HTTPS or loopback HTTP')
    expect(() => createMcpSdkClientAdapter({
      id: 'remote',
      endpoint: 'https://user:secret@mcp.example.test/mcp?token=secret',
    })).toThrow('without embedded credentials')
    expect(() => createMcpSdkClientAdapter({
      id: 'local',
      endpoint: 'http://127.0.0.1:4310/mcp',
    })).not.toThrow()

    const { adapter } = harness()
    const server = await adapter.start()
    await expect(server.invoke('read', 'raw')).rejects.toThrow('must be an object')
  })
})

it('MCP startup ownership keeps an old adapter handle from stopping its replacement session',async()=>{
  const closed:boolean[]=[];
  const adapter=createMcpSdkClientAdapter({id:'owned-handles',endpoint:'https://offline.example.test/mcp',
    clientFactory:()=>{const id=closed.length;closed.push(false);return {
      connect:async()=>{},close:async()=>{closed[id]=true;},ping:async()=>{if(closed[id])throw Error('closed');return {};},
      listTools:async()=>({tools:[]}),listResources:async()=>({resources:[]}),listPrompts:async()=>({prompts:[]}),callTool:async()=>({content:[]}),
    };},transportFactory:()=>({}) as Transport,
  });
  const first=await adapter.start();await first.stop();
  const replacement=await adapter.start();
  try {
    expect(await replacement.health()).toBe(true);
    await first.stop();
    await expect(first.invoke('read',{})).rejects.toThrow('disconnected');
    await expect(first.listTools()).rejects.toThrow('disconnected');
    console.log('MCP_HANDLE_BOUNDARY',JSON.stringify({closed,replacementHealthy:await replacement.health()}));
    expect(await replacement.health()).toBe(true);
    expect(closed).toEqual([true,false]);
  } finally {await replacement.stop();}
});


it('MCP startup cancellation refuses an already aborted owner before constructing a client',async()=>{
  const factory=vi.fn();const controller=new AbortController();controller.abort();
  const adapter=createMcpSdkClientAdapter({id:'pre-aborted',endpoint:'https://offline.example.test/mcp',clientFactory:factory,transportFactory:()=>({}) as Transport});
  await expect(adapter.start(controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(factory).not.toHaveBeenCalled();
});

it('MCP startup cancellation closes late initialization without publishing it',async()=>{
  const {adapter,client}=harness();const controller=new AbortController();
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(client.connect).mockImplementation(async(_transport,options)=>{expect(options?.signal).toBe(controller.signal);await held;});
  const starting=adapter.start(controller.signal);
  try {
    await vi.waitFor(()=>expect(client.connect).toHaveBeenCalledOnce());
    controller.abort();await Promise.resolve();await Promise.resolve();
    expect(client.close).toHaveBeenCalledOnce();
    release();
    await expect(starting).rejects.toMatchObject({name:'AbortError'});
    expect(client.listTools).not.toHaveBeenCalled();expect(client.callTool).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  } finally {release();await starting.catch(()=>undefined);}
});

it('MCP startup cleanup closes a failed initializer and allows a fresh attempt',async()=>{
  const {adapter,client}=harness();vi.mocked(client.connect).mockRejectedValueOnce(new Error('fixture initialization failed'));
  await expect(adapter.start()).rejects.toThrow('fixture initialization failed');
  expect(client.close).toHaveBeenCalledOnce();
  const next=await adapter.start();expect(await next.health()).toBe(true);await next.stop();
  expect(client.close).toHaveBeenCalledTimes(2);
});

it('MCP startup ownership keeps a late old catalog failure from clearing the replacement catalog',async()=>{
  let rejectOld!:(error:Error)=>void;let created=0;let freshLists=0;
  const adapter=createMcpSdkClientAdapter({id:'catalog-owners',endpoint:'https://offline.example.test/mcp',transportFactory:()=>({}) as Transport,
    clientFactory:()=>{const id=++created;return {connect:async()=>{},close:async()=>{},ping:async()=>({}),
      getServerCapabilities:()=>({tools:{}}),listTools:async()=>{if(id===1)return new Promise<{tools:readonly unknown[]}>((_resolve,reject)=>{rejectOld=reject;});freshLists++;return {tools:[{name:'fresh',description:'Fresh fixture',inputSchema:{type:'object'}}]};},
      listResources:async()=>({resources:[]}),listPrompts:async()=>({prompts:[]}),callTool:async()=>({content:[]})};},
  });
  const old=await adapter.start();const pending=old.listTools();const oldOutcome=pending.catch(error=>error);
  await vi.waitFor(()=>expect(rejectOld).toBeTypeOf('function'));await old.stop();
  const fresh=await adapter.start();
  try {
    expect((await fresh.listTools())[0]?.name).toBe('fresh');
    rejectOld(new Error('departed catalog failed'));expect(await oldOutcome).toBeInstanceOf(Error);
    expect((await fresh.listTools())[0]?.name).toBe('fresh');expect(freshLists).toBe(1);
  } finally {rejectOld(new Error('cleanup'));await oldOutcome;await fresh.stop();}
});
