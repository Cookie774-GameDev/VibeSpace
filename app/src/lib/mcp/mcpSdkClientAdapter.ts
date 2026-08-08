import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpClientInvokeOptions,
  McpServerAdapter,
  McpServerClient,
  McpToolDescriptor,
} from './serverManager'

const MAX_DISCOVERY_PAGES = 8
const MAX_DISCOVERY_ITEMS = 64
const MAX_DESCRIPTOR_TEXT = 2_048

export type McpSdkToolClassification = 'read' | 'write' | 'mutation'

export interface McpSdkToolDescriptor extends McpToolDescriptor {
  readonly classification: McpSdkToolClassification
}

export interface McpSdkResourceDescriptor {
  readonly uri: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
}

export interface McpSdkPromptDescriptor {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly arguments: readonly Readonly<{
    name: string
    description?: string
    required: boolean
  }>[]
}

export interface McpSdkCatalog {
  readonly tools: readonly McpSdkToolDescriptor[]
  readonly resources: readonly McpSdkResourceDescriptor[]
  readonly prompts: readonly McpSdkPromptDescriptor[]
  readonly schemaFingerprint: string
}

interface McpSdkPage<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export interface McpSdkClientPort {
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
  getServerCapabilities?(): Readonly<Record<string, unknown>> | undefined
  ping(options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>
  listTools(
    params?: Readonly<{ cursor?: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ tools: readonly unknown[]; nextCursor?: string }>>
  listResources(
    params?: Readonly<{ cursor?: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ resources: readonly unknown[]; nextCursor?: string }>>
  listPrompts(
    params?: Readonly<{ cursor?: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ prompts: readonly unknown[]; nextCursor?: string }>>
  callTool(
    params: Readonly<{ name: string; arguments?: Readonly<Record<string, unknown>> }>,
    resultSchema: undefined,
    options?: Readonly<{
      signal?: AbortSignal
      onprogress?: (update: Readonly<{ progress: number; total?: number; message?: string }>) => void
    }>,
  ): Promise<unknown>
}

export interface McpSdkClientAdapter extends McpServerAdapter {
  readonly getCatalog: (signal?: AbortSignal) => Promise<McpSdkCatalog>
}

export interface McpSdkClientAdapterOptions {
  readonly id: string
  readonly endpoint: string
  readonly clientFactory?: () => McpSdkClientPort
  readonly transportFactory?: (endpoint: URL) => Transport
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, MAX_DESCRIPTOR_TEXT) : fallback
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value).trim()
  return valueText || undefined
}

function canonicalSchema(value: unknown): Record<string, unknown> {
  const schema = record(value)
  return schema ? { ...schema } : { type: 'object', properties: {} }
}

function classifyTool(value: Readonly<Record<string, unknown>>): McpSdkToolClassification {
  const annotations = record(value.annotations)
  if (annotations?.readOnlyHint === true) return 'read'
  if (annotations?.destructiveHint === true) return 'mutation'
  return 'write'
}

function parseTool(value: unknown): McpSdkToolDescriptor | null {
  const item = record(value)
  if (!item) return null
  const name = text(item.name).trim()
  if (!name) return null
  return {
    name,
    title: optionalText(item.title),
    description: text(item.description),
    inputSchema: canonicalSchema(item.inputSchema),
    classification: classifyTool(item),
  }
}

function parseResource(value: unknown): McpSdkResourceDescriptor | null {
  const item = record(value)
  if (!item) return null
  const uri = text(item.uri).trim()
  const name = text(item.name).trim()
  if (!uri || !name) return null
  return {
    uri,
    name,
    title: optionalText(item.title),
    description: optionalText(item.description),
    mimeType: optionalText(item.mimeType),
  }
}

function parsePrompt(value: unknown): McpSdkPromptDescriptor | null {
  const item = record(value)
  if (!item) return null
  const name = text(item.name).trim()
  if (!name) return null
  const args = Array.isArray(item.arguments)
    ? item.arguments.flatMap((candidate) => {
        const argument = record(candidate)
        const argumentName = text(argument?.name).trim()
        return argument && argumentName
          ? [{
              name: argumentName,
              description: optionalText(argument.description),
              required: argument.required === true,
            }]
          : []
      })
    : []
  return {
    name,
    title: optionalText(item.title),
    description: optionalText(item.description),
    arguments: args.slice(0, MAX_DISCOVERY_ITEMS),
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const item = record(value)
  if (item) {
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(item[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function fingerprintMcpSdkCatalog(catalog: Omit<McpSdkCatalog, 'schemaFingerprint'>): string {
  const source = stableSerialize(catalog)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `mcp-sdk-v1:${hash.toString(16).padStart(16, '0')}`
}

async function collectPages<T>(
  load: (cursor?: string) => Promise<McpSdkPage<unknown>>,
  parse: (value: unknown) => T | null,
): Promise<T[]> {
  const values: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_DISCOVERY_PAGES && values.length < MAX_DISCOVERY_ITEMS; page += 1) {
    const result = await load(cursor)
    for (const value of result.items) {
      const parsed = parse(value)
      if (parsed) values.push(parsed)
      if (values.length >= MAX_DISCOVERY_ITEMS) break
    }
    const next = result.nextCursor
    if (!next || cursors.has(next)) break
    cursors.add(next)
    cursor = next
  }
  return values
}

export function createMcpSdkClientAdapter(options: McpSdkClientAdapterOptions): McpSdkClientAdapter {
  const endpoint = new URL(options.endpoint)
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === '[::1]'
  if (
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error(
      'MCP SDK endpoint must use HTTP(S): HTTPS or loopback HTTP without embedded credentials or query secrets',
    )
  }

  const clientFactory = options.clientFactory ?? (() =>
    new Client({ name: 'vibespace-mcp-gateway', version: '1.0.0' }) as McpSdkClientPort)
  const transportFactory = options.transportFactory ?? ((url: URL) =>
    new StreamableHTTPClientTransport(url))
  let client: McpSdkClientPort | null = null
  let startPromise: Promise<McpServerClient> | null = null
  let catalogPromise: Promise<McpSdkCatalog> | null = null

  const start = async (): Promise<McpServerClient> => {
    if (startPromise) return startPromise
    startPromise = (async () => {
      const nextClient = clientFactory()
      await nextClient.connect(transportFactory(endpoint))
      client = nextClient
      const server: McpServerClient = {
        listTools: async (signal) => (await getCatalog(signal)).tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        invoke: async (toolName, input, invokeOptions) => {
          const active = client
          if (!active) throw new Error('MCP SDK client is disconnected')
          const args = record(input)
          if (!args) throw new Error('MCP tool arguments must be an object')
          return active.callTool(
            { name: toolName, arguments: args },
            undefined,
            requestOptions(invokeOptions),
          )
        },
        health: async () => {
          const active = client
          if (!active) return false
          try {
            await active.ping()
            return true
          } catch {
            return false
          }
        },
        stop: async () => {
          const active = client
          client = null
          startPromise = null
          catalogPromise = null
          if (active) await active.close()
        },
      }
      return server
    })().catch((error) => {
      client = null
      startPromise = null
      catalogPromise = null
      throw error
    })
    return startPromise
  }

  const getCatalog = async (signal?: AbortSignal): Promise<McpSdkCatalog> => {
    await start()
    if (catalogPromise) return catalogPromise
    const active = client
    if (!active) throw new Error('MCP SDK client is disconnected')
    catalogPromise = (async () => {
      const capabilities = active.getServerCapabilities?.()
      const tools = await collectPages(
        async (cursor) => {
          const page = await active.listTools(cursor ? { cursor } : undefined, { signal })
          return { items: page.tools, nextCursor: page.nextCursor }
        },
        parseTool,
      )
      const resources = capabilities && !('resources' in capabilities)
        ? []
        : await collectPages(
            async (cursor) => {
              const page = await active.listResources(cursor ? { cursor } : undefined, { signal })
              return { items: page.resources, nextCursor: page.nextCursor }
            },
            parseResource,
          )
      const prompts = capabilities && !('prompts' in capabilities)
        ? []
        : await collectPages(
            async (cursor) => {
              const page = await active.listPrompts(cursor ? { cursor } : undefined, { signal })
              return { items: page.prompts, nextCursor: page.nextCursor }
            },
            parsePrompt,
          )
      const catalog = { tools, resources, prompts }
      return { ...catalog, schemaFingerprint: fingerprintMcpSdkCatalog(catalog) }
    })().catch((error) => {
      catalogPromise = null
      throw error
    })
    return catalogPromise
  }

  return { id: options.id, start, getCatalog }
}

function requestOptions(options?: McpClientInvokeOptions): Readonly<{
  signal?: AbortSignal
  onprogress?: (update: Readonly<{ progress: number; total?: number; message?: string }>) => void
}> {
  return {
    signal: options?.signal,
    onprogress: options?.onProgress
      ? (update) => options.onProgress?.({
          progress: update.progress,
          total: update.total,
          message: update.message,
        })
      : undefined,
  }
}
