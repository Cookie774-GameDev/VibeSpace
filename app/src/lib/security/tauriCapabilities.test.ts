import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readDefaultCapability(): { permissions?: unknown[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const capabilityPath = path.resolve(here, '../../../src-tauri/capabilities/default.json');
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

function readHttpAllowUrls(): string[] {
  const capability = readDefaultCapability();
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

describe('Tauri capability hardening', () => {
  it('does not grant native HTTP access to every local service port', () => {
    const urls = readHttpAllowUrls();

    expect(urls).toContain('http://localhost:11434/*');
    expect(urls).toContain('http://127.0.0.1:11434/*');
    expect(urls).not.toContain('http://localhost:*/*');
    expect(urls).not.toContain('http://127.0.0.1:*/*');
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
});
