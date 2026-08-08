import { useEffect, useState, type ReactNode } from 'react';
import {
  AudioLines,
  Eye,
  Keyboard,
  Maximize2,
  Mic,
  MoveHorizontal,
  ScanEye,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { renderHotkey } from '@/lib/utils';
import { HOTKEYS } from '@/lib/hotkeys';

type SectionGroupProps = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
};

function SectionGroup({ id, title, description, icon: Icon, children }: SectionGroupProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border/70 bg-panel/35 p-4 sm:p-5"
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 text-accent-cyan">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-base font-semibold leading-6 text-foreground">
            {title}
          </h3>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

type InfoCardProps = {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  accent?: 'cyan' | 'copper';
  trailing?: ReactNode;
};

function InfoCard({ icon: Icon, title, description, accent = 'cyan', trailing }: InfoCardProps) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border/60 bg-background/45 p-3.5">
      <span
        className={
          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/55 ' +
          (accent === 'copper' ? 'text-accent-copper' : 'text-accent-cyan')
        }
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold leading-5 text-foreground">{title}</p>
          {trailing}
        </div>
        <div className="mt-1 text-sm leading-5 text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

export function Accessibility() {
  const composerStt = useUIStore((state) => state.composerStt);
  const setComposerStt = useUIStore((state) => state.setComposerStt);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(preference.matches);
    const handleChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    preference.addEventListener('change', handleChange);
    return () => preference.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="mc7f-settings-accessibility flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none">
      <header className="max-w-2xl">
        <h2 className="text-page-title text-foreground">Accessibility</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Make voice input, motion, keyboard use, and assistive technology easier to understand.
          VibeSpace follows your operating-system accessibility preferences where supported.
        </p>
      </header>

      <div className="grid max-w-3xl gap-4">
        <SectionGroup
          id="speech-dictation"
          title="Speech and dictation"
          description="Choose how spoken words become text without changing your voice provider."
          icon={AudioLines}
        >
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/45 p-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/55 text-accent-cyan">
              <Mic aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label
                    htmlFor="composer-stt"
                    className="text-sm font-semibold leading-5 text-foreground"
                  >
                    Voice-to-text in the composer
                  </Label>
                  <p
                    id="composer-stt-description"
                    className="mt-1 text-sm leading-5 text-muted-foreground"
                  >
                    Shows the mic in chat, streams a local transcript, and inserts the final text.
                    Toggle it with <span className="kbd">{renderHotkey(HOTKEYS.COMPOSER_STT)}</span>
                    .
                  </p>
                </div>
                <Switch
                  id="composer-stt"
                  aria-describedby="composer-stt-description"
                  checked={composerStt}
                  onCheckedChange={(value) => setComposerStt(Boolean(value))}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2"
                />
              </div>
            </div>
          </div>

          <InfoCard
            icon={Mic}
            accent="copper"
            title="VibeSpace global dictation"
            description={
              <>
                Press <span className="kbd">{renderHotkey(HOTKEYS.GLOBAL_DICTATION)}</span> to
                dictate into the focused field. Outside VibeSpace, the desktop app opens its compact
                transcription overlay and pastes only after transcription completes. Provider order
                still follows Settings → Speech to Text.
              </>
            }
          />
        </SectionGroup>

        <SectionGroup
          id="visual-comfort"
          title="Visual comfort and focus"
          description="See how VibeSpace responds to motion preferences and distraction-free work."
          icon={Eye}
        >
          <InfoCard
            icon={MoveHorizontal}
            title="Reduced motion"
            description="Mirrors your operating-system preference. Motion is damped or skipped throughout the app, including ambient mode."
            trailing={
              <span
                role="status"
                aria-label="Reduced motion status"
                className={
                  'shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ' +
                  (reducedMotion
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-border bg-panel text-muted-foreground')
                }
              >
                {reducedMotion ? 'Active' : 'Off'}
              </span>
            }
          />

          <InfoCard
            icon={Maximize2}
            title="Workspace Focus Mode"
            description={
              <>
                Hide nonessential workspace chrome while keeping an exit control available. Toggle
                with <span className="kbd">{renderHotkey(HOTKEYS.TOGGLE_FULLSCREEN)}</span>; Escape
                exits the active focus layer.
              </>
            }
          />
        </SectionGroup>

        <SectionGroup
          id="assistive-technology"
          title="Assistive technology"
          description="Controls expose names, descriptions, state, and visible keyboard focus."
          icon={ScanEye}
        >
          <InfoCard
            icon={Keyboard}
            title="Keyboard and focus"
            description="Settings remain reachable in reading order. Focus indicators stay visible without relying on animation or color alone."
            trailing={
              <span className="rounded-md border-2 border-accent-cyan bg-background px-2 py-1 text-xs font-semibold text-foreground">
                Visible focus
              </span>
            }
          />

          <InfoCard
            icon={Eye}
            title="Voice and screen readers"
            description="Interactive controls expose semantic names and current state. Dialogs contain focus, and status changes such as reduced motion are announced without moving focus."
          />
        </SectionGroup>
      </div>
    </div>
  );
}
