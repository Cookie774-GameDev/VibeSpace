// Stdio entry for VibeSpace's existing local MCP manager; shares the running gateway config.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const { endpoint, token } = JSON.parse(
  await readFile(new URL('./state/connection.json', import.meta.url), 'utf8'),
);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token))
  throw Error('Invalid local connection file');
const client = new Client({ name: 'vibespace-desktop-commander-proxy', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const server = new Server(
  { name: 'vibespace-desktop-commander', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, (r) => client.callTool(r.params));
await server.connect(new StdioServerTransport());
process.stdin.on('end', async () => {
  await client.close();
  await server.close();
});
