import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
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
