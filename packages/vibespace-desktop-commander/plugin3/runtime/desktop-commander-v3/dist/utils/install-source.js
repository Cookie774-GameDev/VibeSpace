/**
 * Detect how this server instance was installed/launched, beyond what the
 * MCP client reports in clientInfo. A plugin is not a separate MCP client —
 * the host connects under its own name (e.g. the Claude Code plugin still
 * reports 'claude-code'), so the environment is the only place this signal
 * exists.
 *
 * Checked in priority order:
 * 1. DC_INSTALL_SOURCE — explicit marker set by our own packaging
 *    (e.g. the Claude Code plugin manifest, or future Cowork/host configs).
 * 2. CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA — set by Claude Code itself
 *    when it spawns a plugin's MCP server, so this also covers plugin
 *    versions installed before the explicit marker existed.
 */
export function detectInstallSource() {
    if (process.env.DC_INSTALL_SOURCE) {
        return process.env.DC_INSTALL_SOURCE;
    }
    if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_DATA) {
        return 'claude-code-plugin';
    }
    return undefined;
}
