// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const native = readFileSync('src-tauri/src/relay_active_context.rs', 'utf8');
const sharedGuard = readFileSync('src-tauri/src/native_app_surface.rs', 'utf8');
const commands = [
  ['relay_active_context_open', 'state.open()'],
  ['relay_active_context_update', 'state.update(&owner_handle, revision, context)'],
  ['relay_active_context_close', 'state.close(&owner_handle, revision)'],
  ['relay_active_context_snapshot', 'state.current()'],
] as const;
const compact = (value: string) => value.replace(/\s+/gu, ' ').trim();

function command(name: string): string {
  const definition = native.match(
    new RegExp(`#\\[tauri::command\\]\\s*pub fn ${name}\\([\\s\\S]*?\\n\\}`, 'u'),
  );
  expect(definition, name).not.toBeNull();
  return definition![0];
}

function fields(name: string): string {
  const definition = native.match(
    new RegExp(`pub (?:struct|enum) ${name} \\{([\\s\\S]*?)\\n\\}`, 'u'),
  );
  expect(definition, name).not.toBeNull();
  return compact(definition![1]);
}

describe('native Relay active-context caller boundary', () => {
  it.each(commands)('%s injects the actual Webview even when main owns a child', (name) => {
    expect(command(name)).toMatch(/\bwindow:\s*Webview\s*,/u);
    expect(native).toContain('use tauri::{State, Webview};');
    expect(command(name)).not.toContain('WebviewWindow');
  });

  it.each(commands)(
    '%s guards both framework identities before unchanged state access',
    (name, stateCall) => {
      const body = command(name).split('{').slice(1).join('{');
      expect(compact(body)).toBe(
        `require_main(window.label(), window.window().label())?; ${stateCall} }`,
      );
    },
  );

  it('reuses the exact main/main guard and preserves the existing Relay denial', () => {
    expect(native).toMatch(
      /fn require_main\(webview_label: &str, window_label: &str\) -> Result<\(\), String>\s*\{\s*crate::native_app_surface::ensure_main_caller\(webview_label, window_label\)\s*\.map_err\(\|_\|\s*\{?\s*"Relay active context is available only from the main VibeSpace window\."\.into\(\)\s*\}?\)/u,
    );
    expect(sharedGuard).toMatch(
      /pub fn ensure_main_caller\(label: &str, window_label: &str\) -> Result<\(\), String>\s*\{\s*if label == "main" && window_label == "main"/u,
    );
  });

  it('keeps the same four commands and their caller-independent arguments', () => {
    expect(
      [...native.matchAll(/#\[tauri::command\]\s*pub fn (\w+)\(/gu)].map((match) => match[1]),
    ).toEqual(commands.map(([name]) => name));
    const payloads: Record<string, string> = {
      relay_active_context_open: '',
      relay_active_context_update:
        'owner_handle: String, revision: u64, context: Option<RelayActiveContextUpdate>,',
      relay_active_context_close: 'owner_handle: String, revision: u64,',
      relay_active_context_snapshot: '',
    };
    for (const [name] of commands) {
      const parameters = command(name).match(/pub fn \w+\(([\s\S]*?)\) ->/u)![1];
      expect(compact(parameters)).toBe(
        compact(`state: State<'_, RelayActiveContextState>, window: Webview, ${payloads[name]}`),
      );
    }
  });

  it('preserves every active-context and policy payload field without caller-supplied provenance', () => {
    const contextFields =
      'pub account_id: String, pub workspace_id: Option<String>, pub project_id: String, pub chat_id: String,';
    for (const name of ['RelayActiveContext', 'RelayActiveContextUpdate']) {
      expect(fields(name)).toBe(contextFields);
      expect(native).toMatch(
        new RegExp(
          `#\\[serde\\(rename_all = "camelCase", deny_unknown_fields\\)\\]\\s*pub struct ${name} \\{`,
          'u',
        ),
      );
    }
    expect(fields('RelayActiveContextSnapshot')).toBe(
      'pub generation: u64, pub context: Option<RelayActiveContext>,',
    );
    expect(fields('RelayActiveContextOwner')).toBe('pub owner_handle: String,');
    expect(fields('RelayCollaborationScope')).toBe('Off, Project, EntireApp,');
    expect(fields('RelayPolicy')).toBe(
      'pub revision: u64, pub scope: RelayCollaborationScope, pub excluded_project_ids: Vec<String>, pub excluded_session_ids: Vec<String>,',
    );
    expect(fields('RelayPolicySnapshot')).toBe(
      'pub revision: u64, pub scope: RelayCollaborationScope,',
    );
    expect(native).toMatch(
      /#\[serde\(rename_all = "camelCase", deny_unknown_fields\)\]\s*pub struct RelayPolicy \{/u,
    );
    for (const name of [
      'RelayActiveContextSnapshot',
      'RelayActiveContextOwner',
      'RelayPolicySnapshot',
      'RelayCollaborationScope',
    ]) {
      expect(native).toMatch(
        new RegExp(
          `#\\[serde\\(rename_all = "camelCase"\\)\\]\\s*pub (?:struct|enum) ${name} \\{`,
          'u',
        ),
      );
    }
  });
});
