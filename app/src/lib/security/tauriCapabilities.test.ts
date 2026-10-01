import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readDefaultCapability(): { permissions?: unknown[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const capabilityPath = path.resolve(here, '../../../src-tauri/capabilities/default.json');
  return JSON.parse(fs.readFileSync(capabilityPath, 'utf8')) as { permissions?: unknown[] };
}

function readWorkbenchCapability(): { permissions?: unknown[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const capabilityPath = path.resolve(here, '../../../src-tauri/capabilities/workbench.json');
  return JSON.parse(fs.readFileSync(capabilityPath, 'utf8')) as { permissions?: unknown[] };
}

function readBrowserChatCapability(): {
  permissions?: unknown[];
  webviews?: unknown[];
  windows?: unknown[];
  remote?: unknown;
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const capabilityPath = path.resolve(
    here,
    '../../../src-tauri/capabilities/browser-chat-host.json',
  );
  return JSON.parse(fs.readFileSync(capabilityPath, 'utf8')) as {
    permissions?: unknown[];
    webviews?: unknown[];
    windows?: unknown[];
    remote?: unknown;
  };
}

function readConfiguredCapabilities(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(here, '../../../src-tauri/tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    app?: { security?: { capabilities?: string[] } };
  };
  return config.app?.security?.capabilities ?? [];
}

function readTauriCargoManifest(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, '../../../src-tauri/Cargo.toml'), 'utf8');
}

function readBrowserChatNativeSurface(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(
    path.resolve(here, '../../../src-tauri/src/browser_chat_surface.rs'),
    'utf8',
  );
}

function readHttpAllowUrls(capability = readDefaultCapability()): string[] {
  const httpPermission = capability.permissions?.find(
    (permission) =>
      typeof permission === 'object' &&
      permission !== null &&
      'identifier' in permission &&
      (permission as { identifier?: unknown }).identifier === 'http:default',
  ) as { allow?: Array<{ url?: string }> } | undefined;

  return (
    httpPermission?.allow?.map((entry) => entry.url).filter((url): url is string => Boolean(url)) ??
    []
  );
}

function readConnectSources(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(here, '../../../src-tauri/tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    app?: { security?: { csp?: string } };
  };
  return config.app?.security?.csp ?? '';
}

describe('Tauri capability hardening', () => {
  it('does not grant native HTTP access to every local service port', () => {
    const urls = readHttpAllowUrls();

    expect(urls).toContain('http://localhost:11434/*');
    expect(urls).toContain('http://127.0.0.1:11434/*');
    expect(urls).not.toContain('http://localhost:*/*');
    expect(urls).not.toContain('http://127.0.0.1:*/*');
  });

  it('allows every implemented cloud chat host without broad network wildcards', () => {
    const cloudHosts = [
      'https://api.anthropic.com',
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://api.groq.com',
      'https://openrouter.ai',
      'https://api.deepseek.com',
      'https://api.mistral.ai',
      'https://api.together.xyz',
      'https://api.x.ai',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com',
      'https://coding-intl.dashscope.aliyuncs.com',
      'https://dashscope-us.aliyuncs.com',
      'https://dashscope.aliyuncs.com',
      'https://dashscope-intl.aliyuncs.com',
    ];
    const defaultUrls = readHttpAllowUrls();
    const workbenchUrls = readHttpAllowUrls(readWorkbenchCapability());
    const connectSources = readConnectSources();

    for (const host of cloudHosts) {
      expect(defaultUrls).toContain(`${host}/*`);
      expect(workbenchUrls).toContain(`${host}/*`);
      expect(connectSources).toContain(host);
    }
    expect(defaultUrls).not.toContain('https://*/*');
    expect(workbenchUrls).not.toContain('https://*/*');
  });

  it('enables multi-webview hosting while granting no Browser Chat remote authority', () => {
    const capability = readBrowserChatCapability();

    expect(capability.webviews).toEqual(['main']);
    expect(capability).not.toHaveProperty('windows');
    expect(capability).not.toHaveProperty('remote');
    expect(capability.permissions).toEqual([]);
    expect(readConfiguredCapabilities()).toContain('browser-chat-host');
    expect(readTauriCargoManifest()).toMatch(
      /tauri\s*=\s*\{[^}\r\n]*features\s*=\s*\[[^\]\r\n]*"unstable"/u,
    );
  });

  it('hosts providers as child webviews and emits bounded navigation metadata to main only', () => {
    const source = readBrowserChatNativeSurface();

    expect(source).toMatch(/\bWebviewBuilder\b/u);
    expect(source).toMatch(/\.add_child\s*\(/u);
    expect(source).not.toMatch(/\bWebviewWindowBuilder\b/u);
    expect(source).toMatch(/emit_to\s*\(\s*"main"/u);
    expect(source).toMatch(/browser-chat:\/\/navigation/u);
    expect(source).not.toMatch(/initialization_script/u);
  });
});
