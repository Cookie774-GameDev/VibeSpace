import * as React from 'react';

export const TERMINAL_WARM_IDLE_MS = 5 * 60 * 1000;

export type TerminalWarmIdleVariant = 'mountain' | 'trees' | 'evergreens' | 'sun-mountains';

const TERMINAL_WARM_IDLE_ASSETS: Record<TerminalWarmIdleVariant, string> = {
  mountain: '/assets/themes/warm/terminals/v2/terminal-idle-mountain.png',
  trees: '/assets/themes/warm/terminals/v2/terminal-idle-trees.png',
  evergreens: '/assets/themes/warm/terminals/v2/terminal-idle-evergreens.png',
  'sun-mountains': '/assets/themes/warm/terminals/v2/terminal-idle-sun-mountains.png',
};

export function isWarmTerminalIdleEligible({
  lastActivityAt,
  now,
  pointerEnteredAt,
  pointerInside,
  theme,
}: {
  lastActivityAt: number;
  now: number;
  pointerEnteredAt: number | null;
  pointerInside: boolean;
  theme: string;
}): boolean {
  const visibleAt = lastActivityAt + TERMINAL_WARM_IDLE_MS;
  const dismissedBySamePaneEntry =
    pointerInside && pointerEnteredAt !== null && pointerEnteredAt >= visibleAt;
  return theme === 'warm' && now >= visibleAt && !dismissedBySamePaneEntry;
}

export function terminalWarmIdleVariant(identity: string): TerminalWarmIdleVariant {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const variants = ['mountain', 'trees', 'evergreens', 'sun-mountains'] as const;
  return variants[Math.abs(hash) % variants.length];
}

export function terminalWarmIdleAsset(variant: TerminalWarmIdleVariant): string {
  return TERMINAL_WARM_IDLE_ASSETS[variant];
}

export function TerminalWarmIdleScene({
  identity,
  lastActivityAt,
  pointerEnteredAt,
  pointerInside,
  theme,
}: {
  identity: string;
  lastActivityAt: number;
  pointerEnteredAt: number | null;
  pointerInside: boolean;
  theme: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    setNow(Date.now());
    if (theme !== 'warm') return;
    const remaining = Math.max(0, TERMINAL_WARM_IDLE_MS - (Date.now() - lastActivityAt));
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [lastActivityAt, theme]);

  if (
    !isWarmTerminalIdleEligible({ lastActivityAt, now, pointerEnteredAt, pointerInside, theme })
  ) {
    return null;
  }

  const variant = terminalWarmIdleVariant(identity);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[5]"
      data-testid="terminal-warm-idle-scene"
      data-warm-terminal-idle-variant={variant}
    >
      <img
        alt=""
        className="terminal-state-art"
        data-testid="terminal-warm-idle-art"
        draggable={false}
        role="presentation"
        src={terminalWarmIdleAsset(variant)}
      />
    </div>
  );
}
