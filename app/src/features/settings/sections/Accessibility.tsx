import { useEffect, useState } from 'react';
import { Maximize2, Mic, MoveHorizontal, Eye } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { renderHotkey } from '@/lib/utils';
import { HOTKEYS } from '@/lib/hotkeys';

/**
 * Accessibility settings.
 *
 * Settings:
 *   - Composer STT (`composerStt`) — show the mic button + dictation pipeline
 *     in the chat composer. Defaults to true.
 *   - Reduced motion — read-only display of the user's OS preference. The
 *     app already respects it via `<MotionConfig reducedMotion="user">` and
 *     CSS `prefers-reduced-motion` blocks, but we surface it here for trust.
 *   - Fullscreen workspace shortcut — explained for keyboard users.
 *
 * Future:
 *   - High-contrast theme variant
 *   - Composer text size scaling
 *   - Voice captioning toggle
 */
export function Accessibility() {
  const composerStt = useUIStore((s) => s.composerStt);
  const setComposerStt = useUIStore((s) => s.setComposerStt);

  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Accessibility</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Voice input, motion preferences, and keyboard helpers.
        </p>
      </header>

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="composer-stt" className="flex items-center gap-2">
            <Mic className="h-3.5 w-3.5 text-accent-cyan" />
            Voice-to-text in the composer
          </Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Adds a mic button to the chat input that streams partial transcripts and inserts the
            final text. Uses the local Web Speech API. Toggle with{' '}
            <span className="kbd">{renderHotkey(HOTKEYS.COMPOSER_STT)}</span>.
          </p>
        </div>
        <Switch
          id="composer-stt"
          checked={composerStt}
          onCheckedChange={(v) => setComposerStt(Boolean(v))}
        />
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label className="flex items-center gap-2">
            <MoveHorizontal className="h-3.5 w-3.5 text-accent-cyan" />
            Reduced motion
          </Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Mirrors your operating-system preference. Animations are damped or skipped throughout
            the app, including ambient mode. Change this in your OS accessibility settings.
          </p>
        </div>
        <span
          className={
            'rounded-full border px-2.5 py-0.5 text-metadata ' +
            (reducedMotion
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-border bg-panel text-muted-foreground')
          }
        >
          {reducedMotion ? 'Active' : 'Off'}
        </span>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <Label className="flex items-center gap-2">
          <Maximize2 className="h-3.5 w-3.5 text-accent-cyan" />
          Fullscreen workspace
        </Label>
        <p className="text-metadata text-muted-foreground">
          Hide the sidebar and to-do drawer for distraction-free focus. Toggle with{' '}
          <span className="kbd">{renderHotkey(HOTKEYS.TOGGLE_FULLSCREEN)}</span>.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <Label className="flex items-center gap-2">
          <Eye className="h-3.5 w-3.5 text-accent-cyan" />
          Voice + screen reader
        </Label>
        <p className="text-metadata text-muted-foreground">
          Every interactive control has an accessible name. Modals trap focus, command palette
          actions are keyboard-navigable, and the ambient screen announces itself as a dialog so
          screen readers can describe its state.
        </p>
      </section>
    </div>
  );
}
