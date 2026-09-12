import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pagePaths = [
  'index.html',
  'access/index.html',
  'account/index.html',
  'billing/success/index.html',
  'billing/cancel/index.html',
  'terms/index.html',
  'privacy/index.html',
];
const pages = new Map(
  pagePaths.map((path) => [
    path,
    existsSync(join(siteRoot, path)) ? readFileSync(join(siteRoot, path), 'utf8') : '',
  ]),
);
const visibleText = (html) =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const disclosure = 'VibeSpace Access: $20/month after the introductory 30-day access trial.';
const separatePlans = 'Optional AI/voice/cloud plans are billed separately.';

test('decision pages state the Access price, trial, and separate plan charge', () => {
  for (const path of ['index.html', 'access/index.html', 'account/index.html']) {
    const html = pages.get(path);
    assert.ok(html, `${path} should exist`);
    const text = visibleText(html);
    assert.match(text, new RegExp(disclosure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, new RegExp(separatePlans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('pricing distinguishes app access from optional feature tiers', () => {
  const access = visibleText(pages.get('access/index.html'));
  assert.match(access, /two separate subscriptions/i);
  assert.match(access, /does not include paid AI, voice, or cloud usage/i);
  assert.match(access, /30 consecutive days/i);
  assert.match(access, /starts on first use with a verified account/i);
  assert.match(access, /does not collect payment or start a subscription/i);
  assert.match(access, /deliberately start[\s\S]*\$20[\s\S]*subscription/i);
  assert.match(access, /purchased subscription renews monthly until canceled/i);
});

test('billing result pages never infer entitlement from the page URL', () => {
  const success = pages.get('billing/success/index.html');
  const cancel = pages.get('billing/cancel/index.html');
  assert.match(visibleText(success), /does not confirm that Access is active/i);
  assert.match(visibleText(success), /server-confirmed billing status/i);
  assert.match(visibleText(cancel), /does not confirm a new subscription/i);
  assert.doesNotMatch(success + cancel, /URLSearchParams|session_id|access granted/i);
});

test('account hub uses the authoritative account and keeps billing control server-backed', () => {
  const account = pages.get('account/index.html');
  const script = readFileSync(join(siteRoot, 'account/account.js'), 'utf8');
  assert.match(account, /Use the same VibeSpace identity as the desktop app/i);
  assert.match(account, /id=["']signin-form["']/i);
  assert.match(script, /signInWithPassword/);
  assert.match(script, /\.from\('subscriptions'\)/);
  assert.match(script, /\.from\('desktop_presence'\)/);
  assert.doesNotMatch(account + script, /buy\.stripe\.com|access granted/i);
});

test('terms, privacy, and cancellation copy is bounded and transparent', () => {
  const terms = visibleText(pages.get('terms/index.html'));
  const privacy = visibleText(pages.get('privacy/index.html'));
  assert.match(terms, /cancel.*desktop app.*Billing &amp; Access/is);
  assert.match(terms, /refund eligibility.*applicable law/is);
  assert.doesNotMatch(terms, /non-refundable/i);
  assert.match(terms, /plain-language summary/i);
  assert.match(privacy, /local-first/i);
  assert.match(privacy, /payment processor/i);
  assert.match(privacy, /do not post secrets or personal information/i);
});

test('download onboarding explains account, trial, and optional-plan boundaries', () => {
  const home = visibleText(pages.get('index.html'));
  assert.match(home, /Create or verify your account/i);
  assert.match(home, /review Access status/i);
  assert.match(home, /add optional AI providers/i);
});

test('owned pages provide source-level accessibility basics', () => {
  for (const [path, html] of pages) {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<a class="skip-link" href="#main-content">/);
    assert.match(html, /<main\b[^>]*\bid="main-content"/);
    assert.match(html, /<h1[\s>]/);
    assert.match(html, /aria-label=/);
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, `${path} should have one main landmark`);
  }
  const css = readFileSync(join(siteRoot, 'css/style.css'), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('local links from owned pages resolve to files or same-page fragments', () => {
  for (const [path, html] of pages) {
    const ids = new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]));
    for (const match of html.matchAll(/\shref=["']([^"']+)["']/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|tel:|data:)/.test(href) || href === '#') {
        continue;
      }
      if (href.startsWith('#')) {
        assert.ok(ids.has(href.slice(1)), `${path}: missing fragment ${href}`);
        continue;
      }
      const [pathname, fragment] = href.split('#');
      const target = pathname.startsWith('/')
        ? join(siteRoot, pathname.slice(1))
        : resolve(dirname(join(siteRoot, path)), pathname);
      const candidates = [
        target,
        join(target, 'index.html'),
        target.endsWith('.html') ? target : `${target}.html`,
      ].filter((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      assert.ok(candidates.length > 0, `${path}: missing local target ${href}`);
      if (fragment) {
        const targetPath = candidates[0];
        const targetHtml = readFileSync(targetPath, 'utf8');
        assert.match(
          targetHtml,
          new RegExp(`\\sid=["']${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`),
          `${path}: missing target fragment ${href}`,
        );
      }
    }
  }
});
