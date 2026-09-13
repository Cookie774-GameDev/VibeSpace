import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import nativeSource from '../../../../src-tauri/src/siyuan/surface.rs?raw';

const notebook = '20260913000000-abcdefg';
const root = '20260913000001-abcdefg';
const reports: string[] = [];

function runBootstrap() {
  const template = nativeSource.match(
    /const SIYUAN_GRAPH_FIRST_INITIALIZATION_SCRIPT_TEMPLATE: &str = r#"([\s\S]*?)"#;/u,
  )?.[1];
  if (!template) throw new Error('Native graph bootstrap missing');
  const script = template
    .replace('__MANAGED_PRESENTATION__', '')
    .replace('__TARGET_DOCUMENT_ID__', JSON.stringify(root))
    .replace('__TARGET_NOTEBOOK_ID__', JSON.stringify(notebook))
    .replace('__GRAPH_MODE__', '"local"')
    .replace('__REPORT_NONCE__', '"test-nonce"')
    .replace('__EXPECTED_ORIGIN__', JSON.stringify(window.location.origin));
  new Function(script)();
}

beforeEach(() => {
  vi.useFakeTimers();
  reports.length = 0;
  vi.spyOn(document, 'title', 'get').mockReturnValue('SiYuan');
  vi.spyOn(document, 'title', 'set').mockImplementation((title) => reports.push(title));
  document.body.innerHTML = `
    <button class="dock__item dock__item--active" data-type="file"></button>
    <ul data-url="${notebook}">
      <li data-type="navigation-root"><span class="b3-list-item__arrow b3-list-item__arrow--open"></span></li>
      <li data-node-id="${root}"><span class="b3-list-item__text">Root</span></li>
    </ul>
    <div class="protyle"><div data-node-id="${root}"></div></div>
    <button class="dock__item dock__item--active" data-type="graph"></button>
    <div class="sy__graph fullscreen"></div>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { box: notebook, rootID: root, path: `/${root}.sy` } }),
    })),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as any).__vibespaceGraphBootstrapNonce;
  delete (window as any).__vibespaceGraphPreviousTitle;
  delete (window as any).__vibespaceGraphReportTitle;
  document.body.innerHTML = '';
});

it('opens the browser graph when an unrelated module loader rejects the desktop API', async () => {
  vi.stubGlobal(
    'require',
    vi.fn(() => {
      throw new Error('Module siyuan is unavailable');
    }),
  );
  runBootstrap();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(reports).toContain('__VIBESPACE_SIYUAN_GRAPH__:test-nonce:ready:');
  expect(reports.some((report) => report.includes(':failed:'))).toBe(false);
});

it('opens the browser graph without a desktop module loader', async () => {
  vi.stubGlobal('require', undefined);
  runBootstrap();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reports).toContain('__VIBESPACE_SIYUAN_GRAPH__:test-nonce:ready:');
});

it('retains the desktop openTab path when its API is available', async () => {
  const openTab = vi.fn();
  const app = {};
  vi.stubGlobal(
    'require',
    vi.fn(() => ({ openTab })),
  );
  vi.stubGlobal('siyuan', { ws: { app } });
  runBootstrap();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(openTab).toHaveBeenCalledWith({ app, doc: { id: root } });
  expect(fetch).not.toHaveBeenCalled();
  expect(reports).toContain('__VIBESPACE_SIYUAN_GRAPH__:test-nonce:ready:');
});

it('still rejects a document belonging to another notebook', async () => {
  vi.stubGlobal('require', undefined);
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      code: 0,
      data: { box: 'another-notebook', rootID: root, path: `/${root}.sy` },
    }),
  } as Response);
  runBootstrap();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reports).toContain(
    '__VIBESPACE_SIYUAN_GRAPH__:test-nonce:failed:siyuan_graph_target_unavailable',
  );
  expect(reports.some((report) => report.includes(':ready:'))).toBe(false);
});
