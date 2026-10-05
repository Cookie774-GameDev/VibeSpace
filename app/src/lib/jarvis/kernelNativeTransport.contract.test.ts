import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src-tauri/src/kernel_host.rs', 'utf8');
const frameworkRoot = 'src-tauri/vendor/tauri-2.11.5/src';

function fn(name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 1;
  let end = brace + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end);
}

// These source contracts complement Rust guard/broker tests; they do not
// substitute for compilation and round trips in the official native WebView.
describe('kernel native caller and delivery boundaries', () => {
  it.each(['register_kernel_host', 'kernel_host_respond', 'release_kernel_host'])(
    '%s uses the actual Webview and rejects foreign callers before authority changes',
    (command) => {
      const body = fn(command);
      expect(body).toMatch(/webview:\s*Webview\s*,/);
      expect(body).not.toContain('WebviewWindow');
      const guard = body.indexOf('ensure_kernel_owner_caller(webview.label(), window.label())?');
      expect(guard).toBeGreaterThan(body.indexOf('let window = webview.window()'));
      expect(guard).toBeLessThan(body.indexOf('with_broker('));
      if (command === 'register_kernel_host') expect(guard).toBeLessThan(body.indexOf('nanoid!'));
    },
  );

  it('retains exact main/main owner and top-level client identity', () => {
    expect(fn('ensure_kernel_owner_caller')).toMatch(
      /webview_label\s*!=\s*HOST_LABEL\s*\|\|\s*window_label\s*!=\s*HOST_LABEL/,
    );
    expect(fn('ensure_kernel_owner_caller')).toContain('kernel_host_wrong_window');
    expect(fn('ensure_kernel_client_caller')).toContain('webview_label != window_label');
    expect(fn('ensure_kernel_client_caller')).toContain('kernel_client_window_rejected');
    const client = fn('kernel_client_request');
    expect(client).toMatch(/webview:\s*Webview\s*,/);
    const guard = client.indexOf('ensure_kernel_client_caller(webview.label(), window.label())?');
    expect(guard).toBeGreaterThan(client.indexOf('let window = webview.window()'));
    expect(guard).toBeLessThan(client.indexOf('with_broker('));
    expect(client).toMatch(/broker\.request\(\s*webview\.label\(\)/);
  });

  it('resolves both delivery legs through an exact verified top-level Webview', () => {
    const target = fn('kernel_delivery_webview');
    expect(target).toContain('app.get_webview(label)?');
    expect(target).toContain(
      'kernel_delivery_target_matches(label, webview.label(), webview.window().label())',
    );
    expect(target).not.toMatch(/get_webview_window|\.webviews\(|get_window|emit_all|emit_to/);
    expect(fn('kernel_delivery_target_matches')).toMatch(
      /expected_label\s*==\s*webview_label\s*&&\s*webview_label\s*==\s*window_label/,
    );
    expect(fn('emit_delivery')).toContain(
      'kernel_delivery_webview(app, &delivery.requester_label)',
    );
    expect(fn('kernel_client_request')).toContain(
      'kernel_delivery_webview(&app, &dispatch.host_label)',
    );
    expect(source).not.toContain('get_webview_window(');
  });

  it('preserves native-window destruction hooks, emission semantics and missing-target cleanup', () => {
    expect(fn('register_kernel_host')).toContain('window.on_window_event(');
    expect(fn('register_kernel_host')).toContain('destroy_owner(&destroy_app, &capture)');
    expect(fn('emit_delivery')).toContain('requester.emit(CLIENT_RESPONSE_EVENT, delivery.event)');
    const client = fn('kernel_client_request');
    expect(client).toContain('.emit(HOST_REQUEST_EVENT, dispatch.event.clone())');
    expect(
      client.match(/broker\.abandon\(dispatch.event.epoch, &dispatch.event.request_id\)/g),
    ).toHaveLength(2);
    expect(client).toContain('std::thread::sleep(Duration::from_millis(wait_ms))');
    expect(source).not.toMatch(/\.emit_to\(|\.emit_filter\(/);
  });

  it('keeps broker DTO validation and existing eligibility before pending allocation', () => {
    const request = fn('request');
    expect(request.indexOf('request.validate()?')).toBeLessThan(
      request.indexOf('eligible_client_label'),
    );
    expect(request).toContain(
      'KernelRequestKind::ContextSourceRevision | KernelRequestKind::RunOwnershipDiagnostic',
    );
    expect(request.indexOf('eligible_client_label')).toBeLessThan(
      request.indexOf('self.owner.as_ref()'),
    );
    expect(request.indexOf('request.validate()?')).toBeLessThan(
      request.indexOf('self.pending.insert('),
    );
    for (const fragment of [
      'label != HOST_LABEL',
      'label != "dictation"',
      '!label.starts_with("pet-")',
      '!label.starts_with("preview-")',
    ]) {
      expect(fn('eligible_client_label')).toContain(fragment);
    }
  });

  it('pins the multi-Webview extraction and all-target emitter distinction in the vendored framework', () => {
    const manager = readFileSync(`${frameworkRoot}/lib.rs`, 'utf8');
    const webview = readFileSync(`${frameworkRoot}/webview/mod.rs`, 'utf8');
    const webviewWindow = readFileSync(`${frameworkRoot}/webview/webview_window.rs`, 'utf8');
    expect(webview).toContain('Ok(command.message.webview())');
    expect(webviewWindow).toContain('current webview is not a WebviewWindow');
    expect(manager).toContain('if window.is_webview_window()');
    expect(manager).toContain('self.manager().emit(event, payload)');
  });
});
