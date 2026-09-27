/**
 * WhatsNewModal — the in-app update log.
 *
 * Appears automatically the first time a user launches a new build
 * (see `<WhatsNewHost />` in App.tsx) and is also reachable manually
 * from the TopBar "What's new" button. The modal is purely informational:
 * it never blocks the user from working, and dismissing it is the only
 * action.
 *
 * Visual contract:
 *   - Reuses the shared <DialogContent> primitive so animations + close-X
 *     match the rest of the app.
 *   - Cozy-theme tokens: bg-paper-soft for the header strip, bg-paper for
 *     each release card, accent-copper for the version pill, font-display
 *     for headings, eyebrow for category labels.
 *   - Scrollable body — multiple historical releases stack newest first.
 *
 * Why a modal instead of a side panel: this fires at most once per
 * version bump, so a focused takeover is the right blast radius. Manual
 * re-opening from the TopBar uses the same modal so the experience is
 * consistent.
 */
import * as React from 'react';
import { ChevronRight, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RELEASES, SECTION_META, type Release, type ReleaseSection } from './releases';
import './whats-new.sakura.css';

export interface WhatsNewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the user clicks "Got it" or otherwise dismisses the modal.
   * The host wires this to `useWhatsNew().markSeen()` so the storage
   * key bumps and the auto-show flow doesn't re-fire.
   *
   * Distinct from `onOpenChange(false)` because we want to mark "seen"
   * even when the user clicks the overlay or hits Escape — both paths
   * funnel here.
   */
  onDismiss: () => void;
}

/**
 * Format an ISO date string ('2026-05-29') as the friendly long form
 * the modal shows next to each version pill.
 *
 * We render with the user's locale rather than hardcoding so it picks
 * up "May 29, 2026" / "29. Mai 2026" automatically. Falls back to the
 * raw ISO string if the date fails to parse, which keeps the UI honest.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function WhatsNewModal({ open, onOpenChange, onDismiss }: WhatsNewModalProps) {
  // Treat any close path (overlay click, Escape, X, button) as "seen".
  // Marking-seen is idempotent so calling onDismiss multiple times is safe.
  const handleOpenChange = (next: boolean) => {
    if (!next) onDismiss();
    onOpenChange(next);
  };

  const handleGotIt = () => {
    onDismiss();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-monochrome-surface="whats-new-modal"
        data-vibespace-owned-chrome="whats-new"
        overlayProps={{
          'data-sakura-overlay': 'whats-new',
          'data-vibespace-owned-chrome': 'whats-new',
        }}
        className="whats-new-polished flex h-[min(720px,88vh)] w-[min(840px,94vw)] max-w-none flex-col overflow-hidden p-0"
      >
        {/* ---------- Header strip ---------- */}
        <header className="relative shrink-0 overflow-hidden border-b border-border bg-paper-soft px-6 py-6 sm:px-8">
          <svg className="whats-new-flower" viewBox="0 0 96 104" fill="none" aria-hidden="true">
            <path
              d="M48 71V30M48 55C34 54 27 47 25 39c12-1 19 5 23 16Zm0 7c13-13 21-14 27-10-4 10-13 13-27 10Z"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M48 30c-7-10-18-7-19 1-1 6 4 9 11 9-2 8 3 13 9 13 7 0 10-6 7-13 8 1 13-3 12-10-1-8-11-11-20 0Z"
              fill="currentColor"
              fillOpacity=".18"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            <circle cx="48" cy="37" r="6" fill="currentColor" />
            <path
              d="M28 73h40l-5 23H33l-5-23Z"
              fill="currentColor"
              fillOpacity=".22"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <path d="M25 73h46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <span className="eyebrow block">Update notes</span>
          <DialogTitle className="font-display mt-1 text-page-title leading-tight text-foreground">
            What&apos;s new in Jarvis
          </DialogTitle>
          <p className="mt-1 text-secondary text-muted-foreground">
            Every shipped build, with what changed and what didn&apos;t.
          </p>
        </header>

        {/* ---------- Scrollable release log ---------- */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
          <ul className="flex flex-col gap-5">
            {RELEASES.map((release, idx) => (
              <li key={release.version}>
                <ReleaseCard release={release} latest={idx === 0} />
              </li>
            ))}
          </ul>
        </div>

        {/* ---------- Footer ---------- */}
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-paper-soft px-6 py-3">
          <span className="text-metadata text-muted-foreground">
            Stored locally — Jarvis never phones home for release notes.
          </span>
          <Button variant="accent" size="sm" onClick={handleGotIt} className="gap-1.5">
            <Check className="h-3.5 w-3.5" />
            Got it
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------------------
 * Release card — one per entry in the log.
 * The newest release renders with a soft copper outline so the eye lands
 * on it first; older releases use the neutral border.
 * -------------------------------------------------------------------------*/

interface ReleaseCardProps {
  release: Release;
  latest: boolean;
}

function ReleaseCard({ release, latest }: ReleaseCardProps) {
  const filledSections = release.sections.filter((s) => s.items.length > 0);

  return (
    <article
      className={cn(
        'rounded-lg border bg-paper p-5 shadow-soft transition-colors [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:bg-panel',
        latest
          ? 'border-accent-copper/40 ring-1 ring-accent-copper/20 [html[data-theme=monochrome]_&]:ring-0'
          : 'border-border',
      )}
    >
      {/* Top row: version pill + date + headline */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <VersionPill version={release.version} latest={latest} />
        <span className="text-metadata text-muted-foreground">{formatDate(release.date)}</span>
      </div>

      <h3 className="font-display mt-2 text-page-title leading-tight text-foreground">
        {release.headline}
      </h3>

      {release.summary && (
        <p className="mt-2 text-body text-foreground/85 [html[data-theme=monochrome]_&]:text-foreground">
          {release.summary}
        </p>
      )}

      {filledSections.length > 0 && (
        <div className="mt-4 flex flex-col gap-4">
          {filledSections.map((section) => (
            <SectionBlock key={section.kind} section={section} />
          ))}
        </div>
      )}
    </article>
  );
}

/* --------------------------------------------------------------------------
 * Section block — one per "New / Improved / Fixed / Shipped / Known".
 * Heading is an eyebrow + small icon; items are a tight bulleted list.
 * -------------------------------------------------------------------------*/

interface SectionBlockProps {
  section: ReleaseSection;
}

function SectionBlock({ section }: SectionBlockProps) {
  const meta = SECTION_META[section.kind];
  const Icon = meta.icon;
  const heading = section.heading ?? meta.label;

  return (
    <section>
      <div className="flex items-center gap-1.5">
        <Icon className={cn('h-3.5 w-3.5', meta.toneClass)} strokeWidth={2} />
        <span className="eyebrow">{heading}</span>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {section.items.map((item, i) => (
          <li
            key={i}
            className="flex gap-2 text-body text-foreground/90 [html[data-theme=monochrome]_&]:text-foreground"
          >
            <ChevronRight className={cn('mt-1 h-3 w-3 shrink-0', meta.toneClass)} aria-hidden />
            <span className="leading-snug">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Version pill — the small chip showing "v0.1.1".
 * Latest release gets the filled copper variant; older releases get an
 * outlined neutral chip so the eye still groups them as version markers.
 * -------------------------------------------------------------------------*/

interface VersionPillProps {
  version: string;
  latest: boolean;
}

function VersionPill({ version, latest }: VersionPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-metadata',
        latest
          ? 'bg-accent-copper/15 text-accent-copper ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0'
          : 'bg-muted text-muted-foreground ring-1 ring-border [html[data-theme=monochrome]_&]:ring-0',
      )}
    >
      v{version}
    </span>
  );
}
