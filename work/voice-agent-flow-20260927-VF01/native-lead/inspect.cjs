const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (!page) throw new Error('Official C2 chat page missing');
    const state = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      tauri: Boolean(window.__TAURI_INTERNALS__),
      labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).slice(0, 100),
      buttons: [...document.querySelectorAll('button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 80)).filter(Boolean).slice(0, 100),
    }));
    console.log(JSON.stringify(state, null, 2));
    if (process.argv.includes('--toasts')) {
      console.log('TOASTS', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [data-sonner-toast], [data-state="open"]')].map((node) => node.textContent?.trim().slice(0, 220)).filter(Boolean).filter((value) => /provider|worker|model|voice|codex|opencode/i.test(value)).slice(0, 12)), null, 2));
    }
    if (process.argv.includes('--composer')) {
      const composer = await page.evaluate(() => ({
        message: document.querySelector('[aria-label="Message"]')?.outerHTML.slice(0, 500) || null,
        messageHiddenAncestor: document.querySelector('[aria-label="Message"]')?.closest('[aria-hidden="true"], [inert]')?.outerHTML.slice(0, 200) || null,
        messageRects: [...document.querySelectorAll('[aria-label="Message"]')].map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, parentDisplay: getComputedStyle(node.parentElement).display, ancestorDisplay: (() => { let parent = node.parentElement; while (parent && parent !== document.body) { if (getComputedStyle(parent).display === 'none') return parent.outerHTML.slice(0, 160); parent = parent.parentElement; } return null; })() })),
        send: document.querySelector('button[aria-label="Send message"]')?.outerHTML.slice(0, 400) || null,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => ({ label: node.getAttribute('aria-label'), visible: Boolean(node.getBoundingClientRect().width) })).slice(0, 10),
        tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => ({ name: node.textContent.trim().slice(0, 40), selected: node.getAttribute('aria-selected') })).filter((item) => item.selected === 'true').slice(0, 5),
      }));
      console.log('COMPOSER', JSON.stringify(composer, null, 2));
    }
    if (process.argv.includes('--visibility')) {
      const visibility = await page.evaluate(() => [...document.querySelectorAll('button')].filter((node) => /^(Settings|Voice|Close)$/.test((node.getAttribute('aria-label') || node.textContent || '').trim())).map((node) => ({
        name: (node.getAttribute('aria-label') || node.textContent || '').trim(),
        html: node.outerHTML.slice(0, 400),
        rect: { x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height },
        css: { display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility },
        hiddenAncestor: node.closest('[aria-hidden="true"], [inert]')?.outerHTML.slice(0, 250) || null,
      })));
      const panel = await page.evaluate(() => {
        const node = document.querySelector('#jarvis-panel');
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const ancestors = []; for (let parent = node.parentElement; parent && ancestors.length < 7; parent = parent.parentElement) ancestors.push({ tag: parent.tagName, className: String(parent.className).slice(0, 100), display: getComputedStyle(parent).display, visibility: getComputedStyle(parent).visibility, rect: { width: parent.getBoundingClientRect().width, height: parent.getBoundingClientRect().height } });
        return { state: node.getAttribute('data-voice-appearance-state'), style: { display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility, opacity: getComputedStyle(node).opacity, transform: getComputedStyle(node).transform, width: getComputedStyle(node).width }, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ancestors, controls: [...node.querySelectorAll('button')].map((button) => (button.getAttribute('aria-label') || button.textContent || '').trim()).filter(Boolean) };
      });
      console.log('VISIBILITY', JSON.stringify(visibility, null, 2));
      console.log('PANEL', JSON.stringify(panel, null, 2));
      console.log('ALL_PANELS', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#jarvis-panel')].map((node) => ({ parentDisplay: getComputedStyle(node.parentElement).display, parentHtml: node.parentElement.outerHTML.slice(0, 350), state: node.getAttribute('data-voice-appearance-state') }))), null, 2));
    }
    if (process.argv.includes('--settings')) {
      if (!await page.getByRole('tab', { name: 'Voice', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
      }
      await page.waitForTimeout(500);
      const settings = await page.evaluate(() => ({
        href: location.href,
        labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).filter((label) => /voice|provider|settings/i.test(label)).slice(0, 100),
        buttons: [...document.querySelectorAll('button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 80)).filter((label) => /voice|provider|close|back/i.test(label)).slice(0, 100),
      }));
      console.log('SETTINGS', JSON.stringify(settings, null, 2));
      console.log('VISIBLE', JSON.stringify({ voice: await page.getByRole('tab', { name: 'Voice', exact: true }).isVisible(), settings: await page.getByRole('button', { name: 'Settings', exact: true }).isVisible() }));
      await page.getByRole('tab', { name: 'Voice', exact: true }).click();
      await page.locator('section[aria-label="Voice agent providers"]').waitFor({ timeout: 10000 }).catch(() => {});
      const voice = await page.evaluate(() => ({
        providers: [...document.querySelectorAll('select')].filter((node) => /voice (main agent|worker) provider/i.test(node.getAttribute('aria-label') || '')).map((node) => ({ label: node.getAttribute('aria-label'), value: node.value, options: [...node.options].map((option) => option.value) })),
        labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).filter((label) => /voice|speech|transcri|tts|stt|model/i.test(label)).slice(0, 100),
        tab: document.querySelector('#settings-tab-voice')?.getAttribute('aria-selected'),
        sections: [...document.querySelectorAll('section[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).slice(0, 50),
      }));
      console.log('VOICE', JSON.stringify(voice, null, 2));
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
