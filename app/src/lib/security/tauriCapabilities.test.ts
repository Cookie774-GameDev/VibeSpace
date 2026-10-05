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
  // Rust test fixtures must not satisfy a missing production guard.
  return fs
    .readFileSync(path.resolve(here, '../../../src-tauri/src/browser_chat_surface.rs'), 'utf8')
    .split('\n#[cfg(test)]')[0]!;
}

function nativeFunction(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `production function ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, `end of production function ${name}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
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

  it('keeps provider pages in account-scoped child webviews', () => {
    const source = readBrowserChatNativeSurface();
    const open = nativeFunction(source, 'open_provider');

    expect(open).toMatch(
      /let builder = WebviewBuilder::new\(label\.clone\(\), WebviewUrl::External\(target\)\)/u,
    );
    expect(open).toContain('.data_directory(profile_directory(&app, provider.id, &digest)?)');
    expect(open).toContain('let digest = profile_digest(&profile_key)?;');
    expect(open).toContain('let page_digest = page_digest(&page_id)?;');
    expect(open).toContain('surface_label(provider.id, &digest, &page_digest)?');
    expect(open).toMatch(
      /with_isolated_child_webview2_environment\(\|\| main\.add_child\(builder, position, size\)\)/u,
    );
    expect(nativeFunction(source, 'profile_directory')).toMatch(
      /\.app_data_dir\(\)[\s\S]*\.join\("browser-chat"\)\s*\.join\(digest\)\s*\.join\(provider_id\)/u,
    );
  });

  it('limits top-level windows to allowlisted OAuth popups with no nested popup authority', () => {
    const source = readBrowserChatNativeSurface();
    const open = nativeFunction(source, 'open_provider');

    // A sign-in popup needs its opener; banning every window builder breaks that contract.
    expect(source.match(/WebviewWindowBuilder::new\s*\(/gu)).toHaveLength(1);
    expect(open).toMatch(
      /\.on_new_window\(move \|target, features\| \{\s*if !provider_navigation_allowed\(popup_provider_id, &target\) \{\s*return NewWindowResponse::Deny;/u,
    );
    expect(open).toMatch(
      /let popup = WebviewWindowBuilder::new\(\s*&popup_app,\s*format!\("vibespace-auth-\{popup_id\}"\),\s*WebviewUrl::External\("about:blank"\.parse\(\)\.expect\("valid blank URL"\)\),\s*\)\s*\.window_features\(features\)/u,
    );
    expect(open).toMatch(
      /\.on_navigation\(move \|candidate\| \{\s*provider_navigation_allowed\(popup_provider_id, candidate\)\s*\}\)\s*\.on_new_window\(\|_, _\| NewWindowResponse::Deny\)/u,
    );
    expect(open).toMatch(
      /match popup \{\s*Ok\(window\) => NewWindowResponse::Create \{ window \},\s*Err\(error\) => \{[\s\S]*?NewWindowResponse::Deny\s*\}\s*\}/u,
    );
  });

  it('keeps native commands caller-guarded and validates profile and page identity', () => {
    const source = readBrowserChatNativeSurface();

    expect(nativeFunction(source, 'ensure_main_caller')).toMatch(
      /if label == "main" \{\s*Ok\(\(\)\)\s*\} else \{\s*Err\("browser_chat_caller_not_authorized"\.to_string\(\)\)/u,
    );
    for (const command of [
      'browser_chat_surface_open',
      'browser_chat_surface_hide',
      'browser_chat_surface_hide_all',
    ]) {
      expect(nativeFunction(source, command)).toMatch(
        /\{\s*ensure_main_caller\(caller\.label\(\)\)\?;/u,
      );
    }
    const open = nativeFunction(source, 'browser_chat_surface_open');
    expect(open).toContain('validate_profile_key(&provider_profile_key)?;');
    expect(open).toContain('validate_page_id(&page_id)?;');
    expect(open).toContain('normalized_provider_url(&provider, raw_url)');
    expect(nativeFunction(source, 'validate_profile_key')).toContain('.strip_prefix("profile_")');
    expect(nativeFunction(source, 'validate_profile_key')).toContain('digest.len() == 64');
    expect(nativeFunction(source, 'validate_profile_key')).toContain(
      "byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)",
    );
    expect(nativeFunction(source, 'validate_page_id')).toContain('page_id.len() > 160');
    expect(nativeFunction(source, 'validate_page_id')).toContain(
      'page_id.chars().any(char::is_control)',
    );
  });

  it('emits only normalized allowlisted navigation metadata to main without injecting scripts', () => {
    const source = readBrowserChatNativeSurface();
    const allowNavigation = nativeFunction(source, 'provider_navigation_allowed');
    const normalizedNavigation = nativeFunction(source, 'normalized_navigation');

    expect(allowNavigation).toContain('target.scheme() != "https"');
    expect(allowNavigation).toContain('target.username() != ""');
    expect(allowNavigation).toContain('target.password().is_some()');
    expect(allowNavigation).toContain('_ => return false');
    expect(allowNavigation).toMatch(
      /\.chain\(shared_identity_hosts\.iter\(\)\)\s*\.any\(\|suffix\| host_matches\(&host, suffix\)\)/u,
    );
    expect(nativeFunction(source, 'host_matches')).toContain(
      'host == suffix || host.ends_with(&format!(".{suffix}"))',
    );
    expect(normalizedNavigation).toContain('candidate.scheme() != "https"');
    expect(normalizedNavigation).toContain('candidate.host_str() != Some(provider.hostname)');
    expect(normalizedNavigation).toContain('candidate.port().is_some()');
    expect(normalizedNavigation).toContain('!candidate.username().is_empty()');
    expect(normalizedNavigation).toContain('candidate.password().is_some()');
    expect(normalizedNavigation).toContain(
      'let kind = navigation_kind(provider.id, candidate.path())?;',
    );
    expect(normalizedNavigation).toContain(
      'url: format!("https://{}{}", provider.hostname, candidate.path())',
    );
    expect(source).toMatch(/emit_to\(\s*"main",\s*NAVIGATION_EVENT,/u);
    expect(source).toMatch(/emit_to\(\s*"main",\s*LOAD_EVENT,/u);
    expect(source).not.toMatch(/\.emit\s*\(/u);
    expect(source).toMatch(/browser-chat:\/\/navigation/u);
    expect(source).not.toMatch(/initialization_script/u);
  });
});
