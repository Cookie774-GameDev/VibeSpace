import { invoke } from '@tauri-apps/api/core';
import type { BrowserRuntimeInfo } from './browserTypes';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function asErr(e: unknown): { code: string; message: string; recoverable: boolean } {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return e as { code: string; message: string; recoverable: boolean };
  }
  return {
    code: 'unknown',
    message: e instanceof Error ? e.message : String(e),
    recoverable: true,
  };
}

export async function browserDetect() {
  if (!isTauriRuntime()) return [] as Array<{ name: string; path: string; kind: string }>;
  try {
    return await invoke<Array<{ name: string; path: string; kind: string }>>(
      'browser_detect_installations',
    );
  } catch {
    return [];
  }
}

export async function browserStatus(): Promise<BrowserRuntimeInfo> {
  if (!isTauriRuntime()) {
    return { running: false, last_error: 'Desktop shell required for Vibe Browser runtime.' };
  }
  try {
    return await invoke<BrowserRuntimeInfo>('browser_status');
  } catch (e) {
    return { running: false, last_error: asErr(e).message };
  }
}

export async function browserStart(executable?: string) {
  if (!isTauriRuntime()) {
    return {
      ok: false as const,
      error: { code: 'not_tauri', message: 'Desktop app required.', recoverable: true },
    };
  }
  try {
    const status = await invoke<BrowserRuntimeInfo>('browser_start', {
      executable: executable ?? null,
    });
    return { ok: true as const, status };
  } catch (e) {
    return { ok: false as const, error: asErr(e) };
  }
}

export async function browserStop() {
  if (!isTauriRuntime()) return false;
  try {
    return await invoke<boolean>('browser_stop');
  } catch {
    return false;
  }
}

export async function browserClearProfile() {
  if (!isTauriRuntime()) return false;
  try {
    return await invoke<boolean>('browser_clear_profile');
  } catch {
    return false;
  }
}

/** Minimal CDP over WebSocket for page control + screencast frames. */
export class CdpSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private onFrame: ((base64: string) => void) | null = null;
  private onEvent: ((method: string, params: unknown) => void) | null = null;
  private screencastDesired = false;
  private screencastState: 'stopped' | 'starting' | 'started' | 'stopping' = 'stopped';
  private screencastTransition: Promise<void> | null = null;
  private connectionEpoch = 0;

  async connect(wsUrl: string): Promise<void> {
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('CDP WebSocket failed'));
      ws.onmessage = (ev) => this.handleMessage(String(ev.data));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.connectionEpoch += 1;
        this.screencastDesired = false;
        this.screencastState = 'stopped';
        this.screencastTransition = null;
        this.rejectPending(new Error('CDP WebSocket closed'));
      };
    });
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleMessage(raw: string) {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.screencastFrame' && msg.params && typeof msg.params === 'object') {
      const params = msg.params as { data?: string; sessionId?: number };
      if (params.data) this.onFrame?.(params.data);
      if (params.sessionId != null) {
        void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(
          () => undefined,
        );
      }
    }
    if (msg.method) this.onEvent?.(msg.method, msg.params);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20_000);
    });
  }

  onScreencast(cb: (base64: string) => void) {
    this.onFrame = cb;
  }

  onCdpEvent(cb: (method: string, params: unknown) => void) {
    this.onEvent = cb;
  }

  async startScreencast() {
    return this.setScreencastEnabled(true);
  }

  async stopScreencast() {
    return this.setScreencastEnabled(false);
  }

  setScreencastEnabled(enabled: boolean): Promise<void> {
    this.screencastDesired = enabled;
    return this.reconcileScreencast();
  }

  private reconcileScreencast(): Promise<void> {
    if (this.screencastTransition) return this.screencastTransition;
    const epoch = this.connectionEpoch;
    const transition = this.runScreencastReconciler(epoch);
    this.screencastTransition = transition;
    void transition
      .finally(() => {
        if (this.screencastTransition === transition) this.screencastTransition = null;
      })
      .catch(() => undefined);
    return transition;
  }

  private async runScreencastReconciler(epoch: number): Promise<void> {
    while (epoch === this.connectionEpoch) {
      if (this.screencastDesired) {
        if (this.screencastState === 'started') return;
        this.screencastState = 'starting';
        try {
          await this.send('Page.enable');
          await this.send('Runtime.enable');
          await this.send('Network.enable');
          await this.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 60,
            maxWidth: 1280,
            maxHeight: 800,
            everyNthFrame: 1,
          });
        } catch (error) {
          if (epoch === this.connectionEpoch) this.screencastState = 'stopped';
          throw error;
        }
        if (epoch !== this.connectionEpoch) return;
        this.screencastState = 'started';
        continue;
      }

      if (this.screencastState === 'stopped') return;
      this.screencastState = 'stopping';
      try {
        await this.send('Page.stopScreencast');
      } catch (error) {
        if (epoch === this.connectionEpoch) this.screencastState = 'started';
        throw error;
      }
      if (epoch !== this.connectionEpoch) return;
      this.screencastState = 'stopped';
    }
  }

  async navigate(url: string) {
    return this.send('Page.navigate', { url });
  }

  async reload(ignoreCache = false) {
    return this.send('Page.reload', { ignoreCache });
  }

  async evaluate(expression: string) {
    // Restricted: only used for read-only probes with fixed expressions from our code, never model JS.
    return this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async inputClick(x: number, y: number) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  async inputType(text: string) {
    await this.send('Input.insertText', { text });
  }

  async inputKey(key: string) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }

  async close() {
    const ws = this.ws;
    this.connectionEpoch += 1;
    this.screencastDesired = false;
    this.screencastState = 'stopped';
    this.screencastTransition = null;
    this.ws = null;
    this.rejectPending(new Error('CDP session closed'));
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function resolvePageWsUrl(browserWsUrl: string): Promise<string | null> {
  // browserWsUrl is often browser-level; list targets for a page.
  try {
    const u = new URL(browserWsUrl);
    const port = u.port;
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = (await res.json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
      url?: string;
    }>;
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? browserWsUrl;
  } catch {
    return browserWsUrl;
  }
}
