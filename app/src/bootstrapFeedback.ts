export async function mountWithFeedback(
  root: HTMLElement,
  load: () => Promise<void>,
  retry: () => void,
) {
  const panel = document.createElement('section');
  panel.setAttribute('role', 'status');
  panel.style.cssText =
    'min-height:100vh;display:grid;place-content:center;gap:12px;padding:32px;box-sizing:border-box;background:#241f1a;color:#f7eddf;font:16px system-ui;text-align:center';
  const title = document.createElement('strong');
  title.textContent = 'Opening VibeSpace';
  title.style.cssText = 'font-size:24px;letter-spacing:-.5px';
  const detail = document.createElement('p');
  detail.textContent = 'Loading your workspace…';
  detail.style.cssText = 'margin:0;color:#c7b8a7';
  panel.append(title, detail);
  root.replaceChildren(panel);
  try {
    await load();
  } catch {
    panel.setAttribute('role', 'alert');
    title.textContent = 'VibeSpace could not load';
    detail.textContent = 'Try reloading the window. Your saved work stays on this computer.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload VibeSpace';
    button.style.cssText =
      'justify-self:center;margin-top:8px;padding:10px 18px;border:1px solid #d88d67;border-radius:8px;background:#c16d43;color:white;font:inherit;cursor:pointer';
    button.addEventListener('click', retry, { once: true });
    panel.append(button);
    root.replaceChildren(panel);
  }
}
