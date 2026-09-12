import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  createMcpSdkClientAdapter,
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
