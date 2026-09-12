export const SAFE_RELAY_TOOLS = new Set(['fs.list', 'fs.read']);

export const TOOL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'files.list',
    label: 'List project files',
    category: 'files',
    classification: 'read',
    relayTool: 'fs.list',
    approvalRequired: false,
  }),
  Object.freeze({
    id: 'files.read',
    label: 'Read a project file',
    category: 'files',
    classification: 'read',
    relayTool: 'fs.read',
    approvalRequired: false,
  }),
  Object.freeze({
    id: 'files.write',
    label: 'Write a project file',
    category: 'files',
    classification: 'write',
    approvalRequired: true,
  }),
  Object.freeze({
    id: 'browser.playwright',
    label: 'Control an approved browser session',
    category: 'browser',
    classification: 'browser_mutation',
    approvalRequired: true,
  }),
  Object.freeze({
    id: 'terminal.run',
    label: 'Run an approved terminal command',
    category: 'terminal',
    classification: 'command',
    approvalRequired: true,
  }),
  Object.freeze({
    id: 'mcp.invoke',
    label: 'Use an approved VibeSpace MCP tool',
    category: 'mcp',
    classification: 'external_mutation',
    approvalRequired: true,
  }),
]);

export function capabilityCatalog(connected: boolean, advertisedTools: readonly string[]) {
  const advertised = new Set(advertisedTools);
  return TOOL_CATALOG.map((tool) => {
    const relayTool = 'relayTool' in tool ? tool.relayTool : undefined;
    const available = Boolean(connected && relayTool && advertised.has(relayTool));
    const unavailableReason = available
      ? undefined
      : !relayTool
        ? 'This capability is not implemented in the current VibeSpace ChatGPT MCP bridge.'
        : connected
          ? 'This read capability is not included in the active workspace grant.'
          : 'The signed-in VibeSpace desktop relay is offline.';
    return {
      id: tool.id,
      label: tool.label,
      category: tool.category,
      classification: tool.classification,
      available,
      approval_required: tool.approvalRequired,
      ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
    };
  });
}
