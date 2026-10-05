// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const native = readFileSync(new URL('../../../src-tauri/src/context_search.rs', import.meta.url), 'utf8');
const commandNames = [
  'context_search_replace_documents',
  'context_search_delete_documents',
  'context_search_query',
  'context_search_status',
  'context_search_acknowledge_rebuild',
] as const;

function command(name: string): string {
  const start = native.indexOf(`pub async fn ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const following = native.indexOf('\n#[', start);
  return native.slice(start, following < 0 ? native.length : following);
}

describe('native Context search caller boundary', () => {
  it.each(commandNames)('%s accepts the real main Webview in a multi-Webview window', (name) => {
    // WebviewWindow extraction fails before the handler when SiYuan adds a child.
    // The injected Webview is framework provenance, never a caller-supplied label.
    expect(command(name)).toMatch(/\bwindow:\s*tauri::Webview\s*,/u);
    expect(command(name)).not.toContain('tauri::WebviewWindow');
  });

  it.each(commandNames)('%s checks injected Webview and owner-window identity before index IO', (name) => {
    const body = command(name);
    expect(body).toMatch(/\{\s*ensure_main_caller\(window\.label\(\), window\.window\(\)\.label\(\)\)\?;/u);
    expect(body.indexOf('ensure_main_caller(')).toBeLessThan(body.indexOf('app_index_location('));
    expect(body).toContain('&request.account_id');
    expect(body).toContain('&request.map_id');
  });

  it('reuses the existing strict main/main caller guard and preserves the Context denial code', () => {
    expect(native).toMatch(/fn ensure_main_caller\(webview_label: &str, window_label: &str\) -> Result<\(\), String>\s*\{\s*crate::native_app_surface::ensure_main_caller\(webview_label, window_label\)\s*\.map_err\(\|_\| "context_search_caller_not_authorized"\.to_string\(\)\)/u);
    const guard = readFileSync(new URL('../../../src-tauri/src/native_app_surface.rs', import.meta.url), 'utf8');
    expect(guard).toMatch(/pub fn ensure_main_caller\(label: &str, window_label: &str\) -> Result<\(\), String>\s*\{\s*if label == "main" && window_label == "main"/u);
  });

  it('keeps caller provenance out of deny-unknown-fields request payloads', () => {
    for (const name of ['ContextSearchReplaceRequest', 'ContextSearchDeleteRequest', 'ContextSearchRequest', 'ContextSearchStatusRequest']) {
      const definition = native.match(new RegExp(`#\\[serde\\(rename_all = "camelCase", deny_unknown_fields\\)\\]\\s*pub struct ${name} \\{([\\s\\S]*?)\\n\\}`, 'u'));
      expect(definition, name).not.toBeNull();
      expect(definition![1]).toContain('pub account_id: String');
      expect(definition![1]).toContain('pub map_id: String');
      expect(definition![1]).not.toMatch(/caller|webview|window_label/iu);
    }
  });
});
