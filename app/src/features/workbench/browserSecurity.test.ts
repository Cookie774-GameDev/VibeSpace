import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_BROWSER_SANDBOX,
  LOOPBACK_BROWSER_SANDBOX,
  TRUSTED_MEDIA_EMBED_SANDBOX,
  browserFramePolicy,
  normalizeBrowserUrl,
  toEmbeddableUrl,
} from './browserSecurity';

describe('Workbench browser isolation', () => {
  it('uses browser tabs for full remote sites when the native engine is unavailable', () => {
    expect(browserFramePolicy('YouTube.com', 'http://localhost:5173', false).delivery).toBe(
      'external',
    );
    expect(browserFramePolicy('https://example.com', 'http://localhost:5173', false).delivery).toBe(
      'external',
    );
  });

  it('uses the official player in web mode without losing its referrer', () => {
    const policy = browserFramePolicy('https://youtu.be/abc123', 'http://localhost:5173', false);
    expect(policy.delivery).toBe('embedded');
    expect(policy.src).toBe('https://www.youtube-nocookie.com/embed/abc123');
    expect(policy.referrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(policy.usedEmbed).toBe(true);
  });
  it('keeps local preview documents opaque even if they redirect to the host origin', () => {
    const policy = browserFramePolicy('http://127.0.0.1:18724/');
    expect(policy.sandbox.split(' ')).not.toContain('allow-same-origin');
    expect(policy.sandbox.split(' ')).toContain('allow-scripts');
  });
  it('rejects the host app origin while allowing a distinct local preview origin', () => {
    expect(() =>
      browserFramePolicy('http://localhost:5174/?route=chat', 'http://localhost:5174'),
    ).toThrow(/app origin/i);
    expect(() => browserFramePolicy('http://tauri.localhost/', 'http://tauri.localhost')).toThrow(
      /app origin/i,
    );
    expect(browserFramePolicy('http://127.0.0.1:18724/', 'http://localhost:5174').delivery).toBe(
      'embedded',
    );
  });
  it('allows ordinary web and localhost URLs but rejects privileged schemes', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('https://docs.example.com/api')).toBe(
      'https://docs.example.com/api',
    );

    for (const unsafe of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'tauri://localhost',
      'data:text/html,<script>alert(1)</script>',
      'https://user:password@example.com/private',
    ]) {
      expect(() => normalizeBrowserUrl(unsafe)).toThrow(/http/i);
    }
  });

  it.each([
    'https://vibespaceos.com',
    'https://www.amazon.com',
    'https://www.youtube.com',
    'https://www.wikipedia.org',
    'https://example.com',
  ])('routes %s to the in-window native child instead of an iframe or external browser', (url) => {
    expect(EMBEDDED_BROWSER_SANDBOX).toContain('allow-scripts');
    expect(EMBEDDED_BROWSER_SANDBOX).not.toContain('allow-same-origin');
    expect(browserFramePolicy(url)).toMatchObject({
      referrerPolicy: 'no-referrer',
      sandbox: EMBEDDED_BROWSER_SANDBOX,
      frameBlocked: false,
      delivery: 'native-child',
    });
  });

  it('uses loopback sandbox for localhost so local apps are not blank', () => {
    const policy = browserFramePolicy('http://localhost:5173');
    expect(policy.sandbox).toBe(LOOPBACK_BROWSER_SANDBOX);
    expect(policy.sandbox).not.toContain('allow-same-origin');
    expect(policy.frameBlocked).toBe(false);
    expect(policy.delivery).toBe('embedded');
  });

  it('rewrites YouTube watch URLs to the privacy embed endpoint', () => {
    const rewritten = toEmbeddableUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(rewritten.usedEmbed).toBe(true);
    expect(rewritten.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');

    const policy = browserFramePolicy('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(policy.usedEmbed).toBe(false);
    expect(policy.frameBlocked).toBe(false);
    expect(policy.delivery).toBe('native-child');
  });

  it('does not grant the trusted-media sandbox to arbitrary remote or loopback pages', () => {
    expect(browserFramePolicy('https://example.com').sandbox).toBe(EMBEDDED_BROWSER_SANDBOX);
    expect(browserFramePolicy('https://example.com').referrerPolicy).toBe('no-referrer');
    expect(browserFramePolicy('http://127.0.0.1:5173').sandbox).toBe(LOOPBACK_BROWSER_SANDBOX);
    expect(TRUSTED_MEDIA_EMBED_SANDBOX).not.toBe(EMBEDDED_BROWSER_SANDBOX);
  });

  it('keeps YouTube home pages in the native child without pretending iframe support', () => {
    const policy = browserFramePolicy('https://www.youtube.com/');
    expect(policy.frameBlocked).toBe(false);
    expect(policy.delivery).toBe('native-child');
    expect(policy.externalUrl).toContain('youtube.com');
  });
});
