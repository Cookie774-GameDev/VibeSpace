export const EMBEDDED_BROWSER_SANDBOX = 'allow-forms allow-modals allow-popups allow-scripts';

/**
 * Approved cross-origin media embeds need their provider origin intact for
 * player storage and scripts. They remain cross-origin from VibeSpace, so
 * this does not grant access to the parent document or Tauri bridge.
 */
export const TRUSTED_MEDIA_EMBED_SANDBOX =
  'allow-forms allow-modals allow-popups allow-scripts allow-same-origin';

/** Local content stays opaque even after redirects to the trusted app origin. */
export const LOOPBACK_BROWSER_SANDBOX = 'allow-forms allow-modals allow-popups allow-scripts';

const FORBIDDEN_SCHEME = /^(?:javascript|data|file|tauri|asset|chrome|about|vbscript):/i;

/** Hosts whose full sites are not usable in a Workbench iframe (XFO, CSP, or site challenge). */
const KNOWN_FRAME_BLOCKED_HOSTS = [
  'amazon.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'google.com',
  'www.google.com',
  'accounts.google.com',
  'facebook.com',
  'www.facebook.com',
  'twitter.com',
  'x.com',
  'www.x.com',
  'instagram.com',
  'www.instagram.com',
  'github.com',
  'www.github.com',
  'reddit.com',
  'www.reddit.com',
  'linkedin.com',
  'www.linkedin.com',
  'netflix.com',
  'www.netflix.com',
];

// Keep web-mode embedding conservative: cross-origin frame denial cannot be
// observed reliably from an iframe load event. These static pages are verified
// to render without X-Frame-Options or frame-ancestors restrictions.
const KNOWN_FRAME_ALLOWED_HOSTS = ['example.com', 'vibespaceos.com'];

export function normalizeBrowserUrl(input: string): string {
  const raw = input.trim();
  if (!raw || FORBIDDEN_SCHEME.test(raw)) {
    throw new Error('Only HTTP and HTTPS pages can open in the Workbench browser.');
  }

  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw
    : /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)
      ? `http://${raw}`
      : `https://${raw}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can open in the Workbench browser.');
  }
  if (url.username || url.password) {
    throw new Error('HTTP URLs with embedded credentials are not allowed.');
  }
  return url.toString();
}

export function isLoopbackHost(hostname: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
}

export function isKnownFrameBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return KNOWN_FRAME_BLOCKED_HOSTS.some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`),
  );
}

/**
 * Convert watch URLs to the official embed endpoint when possible so the
 * panel can show a real player instead of "refused to connect".
 */
export function toEmbeddableUrl(input: string): { src: string; usedEmbed: boolean } {
  const normalized = normalizeBrowserUrl(input);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0];
    if (id) {
      return {
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
        usedEmbed: true,
      };
    }
  }

  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    const id = url.searchParams.get('v');
    if (id) {
      return {
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
        usedEmbed: true,
      };
    }
    const shorts = url.pathname.match(/^\/shorts\/([^/]+)/);
    if (shorts?.[1]) {
      return {
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(shorts[1])}`,
        usedEmbed: true,
      };
    }
    // Channel/home pages cannot be embedded — caller should open externally.
  }

  return { src: normalized, usedEmbed: false };
}

export function browserFramePolicy(
  input: string,
  appOrigin = typeof window === 'undefined' ? undefined : window.location.origin,
  nativeAvailable = true,
): {
  src: string;
  sandbox: string;
  referrerPolicy: 'no-referrer' | 'strict-origin-when-cross-origin';
  allow: string;
  frameBlocked: boolean;
  usedEmbed: boolean;
  externalUrl: string;
  delivery: 'embedded' | 'native-child' | 'external';
} {
  const externalUrl = normalizeBrowserUrl(input);
  if (appOrigin && new URL(externalUrl).origin === appOrigin) {
    throw new Error('The VibeSpace app origin cannot open inside a browser panel.');
  }
  const { src, usedEmbed } = toEmbeddableUrl(input);
  const frameHost = new URL(src).hostname;
  const loopback = isLoopbackHost(frameHost);
  const frameBlocked = isKnownFrameBlockedHost(new URL(externalUrl).hostname);
  const frameAllowed = KNOWN_FRAME_ALLOWED_HOSTS.some(
    (host) => frameHost === host || frameHost === `www.${host}`,
  );
  // Arbitrary remote pages cannot be made reliable in an iframe because sites
  // legitimately enforce X-Frame-Options/CSP. They stay inside VibeSpace in a
  // capability-free native child WebView instead.
  const delivery = loopback
    ? 'embedded'
    : nativeAvailable
      ? 'native-child'
      : usedEmbed || (frameAllowed && !frameBlocked)
        ? 'embedded'
        : 'external';

  return {
    src,
    sandbox: loopback
      ? LOOPBACK_BROWSER_SANDBOX
      : usedEmbed
        ? TRUSTED_MEDIA_EMBED_SANDBOX
        : EMBEDDED_BROWSER_SANDBOX,
    referrerPolicy: usedEmbed ? 'strict-origin-when-cross-origin' : 'no-referrer',
    allow: usedEmbed
      ? 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
      : "clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'",
    frameBlocked,
    usedEmbed: delivery === 'embedded' && usedEmbed,
    externalUrl,
    delivery,
  };
}
