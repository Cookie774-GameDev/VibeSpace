import { languageMeta } from './editorLanguages';

/** Any language can open the preview pane; device frame is most useful for web-ish types. */
export function supportsEditorPreview(_languageOrExt: string): boolean {
  return true;
}

export function prefersDevicePreview(languageOrExt: string): boolean {
  return languageMeta(languageOrExt).preview === 'device';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PREVIEW_DIAGNOSTICS = `<script>
(() => {
  const report = (message) => {
    let box = document.getElementById('vibespace-preview-error');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'vibespace-preview-error';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;z-index:2147483647;left:12px;right:12px;bottom:12px;max-height:40vh;overflow:auto;margin:0;padding:12px;border:1px solid #c55445;border-radius:8px;background:#361b1b;color:#fff;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap';
      document.documentElement.appendChild(box);
    }
    box.textContent = 'Preview error: ' + message;
  };
  window.addEventListener('error', (event) => {
    if (event.message) report(event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    report(String(event.reason?.message ?? event.reason ?? 'Unhandled promise rejection'));
  });
})();
</script>`;

function withPreviewDiagnostics(html: string): string {
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${PREVIEW_DIAGNOSTICS}`);
  }
  return html.replace(
    /<html(?:\s[^>]*)?>/i,
    (start) => `${start}<head>${PREVIEW_DIAGNOSTICS}</head>`,
  );
}

/**
 * Build a self-contained HTML document for the device iframe preview.
 * Never uses eval; HTML for html/svg is injected as-is into srcDoc sandbox.
 */
export function buildDevicePreviewDocument(languageOrExt: string, source: string): string {
  const lang = languageOrExt.replace(/^\./, '').toLowerCase();
  const body = source.slice(0, 200_000);

  if (lang === 'html' || lang === 'htm') {
    // Ensure a full document so mobile viewport meta works when present.
    if (/<html[\s>]/i.test(body)) return withPreviewDiagnostics(body);
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>${PREVIEW_DIAGNOSTICS}</head><body>${body}</body></html>`;
  }

  if (lang === 'svg') {
    const svg = body.trim().startsWith('<')
      ? body
      : `<svg xmlns="http://www.w3.org/2000/svg">${escapeHtml(body)}</svg>`;
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#0b0d12}svg{max-width:100%;max-height:100%}</style></head><body>${svg}</body></html>`;
  }

  if (lang === 'css') {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>${body.replace(/<\/style/gi, '<\\/style')}</style></head><body>
      <main class="preview-root">
        <h1>CSS preview</h1>
        <p>Sample content styled by your stylesheet.</p>
        <button type="button">Button</button>
        <input placeholder="Input" />
        <div class="card">Card</div>
      </main>
    </body></html>`;
  }

  if (lang === 'js' || lang === 'javascript') {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>${PREVIEW_DIAGNOSTICS}</head><body><main id="preview-root"></main><script>${body.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  }

  if (lang === 'md' || lang === 'mdx' || lang === 'markdown') {
    const html = renderSafeMarkdownPreview(body);
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body{font:16px/1.55 system-ui,sans-serif;margin:0;padding:20px;background:#f7f2ea;color:#1c1a16}
  h1,h2,h3{font-family:Georgia,serif}
  code,pre{font-family:ui-monospace,monospace;background:#ece4d6}
  pre{padding:12px;overflow:auto;border-radius:8px}
  a{color:#a65b2a}
</style></head><body>${html}</body></html>`;
  }

  // Source preview for code languages
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body{margin:0;background:#12141c;color:#e8dcc8;font:13px/1.5 ui-monospace,monospace}
  header{padding:10px 14px;border-bottom:1px solid #2a2e3a;color:#c9a27a;font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}
  pre{margin:0;padding:14px;white-space:pre-wrap;word-break:break-word}
</style></head><body><header>${escapeHtml(lang || 'source')} preview</header><pre>${escapeHtml(body)}</pre></body></html>`;
}

/**
 * Minimal safe Markdown → HTML. Escapes all HTML first so no raw tags/scripts run.
 */
export function renderSafeMarkdownPreview(source: string): string {
  const escaped = escapeHtml(source.slice(0, 100_000));
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="wb-md-code"><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^###\s+/.test(line)) {
      closeList();
      out.push(`<h3>${line.replace(/^###\s+/, '')}</h3>`);
      continue;
    }
    if (/^##\s+/.test(line)) {
      closeList();
      out.push(`<h2>${line.replace(/^##\s+/, '')}</h2>`);
      continue;
    }
    if (/^#\s+/.test(line)) {
      closeList();
      out.push(`<h1>${line.replace(/^#\s+/, '')}</h1>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineFormat(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      out.push('<br />');
      continue;
    }
    closeList();
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="wb-md-code"><code>${codeBuf.join('\n')}</code></pre>`);
  closeList();
  return out.join('\n');
}

function inlineFormat(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
