import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/App.tsx', 'utf8');

describe('ordinary app tool gateway host', () => {
  it('mounts exactly one renderer host in the ordinary runtime shell', () => {
    expect(source).toMatch(
      /import\s+\{\s*ToolGatewayHost\s*\}\s+from\s+['"]@\/lib\/harness\/ToolGatewayHost['"]/u,
    );
    expect(source.match(/<ToolGatewayHost\s*\/>/gu)).toHaveLength(1);
    expect(source.lastIndexOf('<ToolGatewayHost />')).toBeGreaterThan(
      source.lastIndexOf('<KernelBridgeBootstrap />'),
    );
    expect(source).toContain('installToolGatewayPluginReadPort');
    expect(source).toContain('run: (request) => securityRuntime!.runReadOnlyPlugin(request)');
    expect(source).toContain('disposePluginReadPort?.()');
  });
});
