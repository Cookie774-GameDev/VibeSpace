import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Welcome } from './steps/Welcome';
import { Persona } from './steps/Persona';
import { WhatsNew } from './steps/WhatsNew';
import { Providers } from './steps/Providers';
import { Permissions } from './steps/Permissions';
import { Demo } from './steps/Demo';

const STEPS = ['welcome', 'persona', 'whats-new', 'providers', 'permissions', 'demo'] as const;
const STEP_LABELS: Record<(typeof STEPS)[number], string> = {
  welcome: 'Welcome',
  persona: 'Personality',
  'whats-new': "What's new",
  providers: 'Providers',
  permissions: 'Permissions',
  demo: 'Demo',
};

/**
 * Onboarding root.
 *
 * - Progress dots at top
 * - Animated step transitions in the middle
 * - Back / Next chrome at the bottom for middle steps (Welcome and Demo
 *   carry their own primary CTA so we hide the chrome on those)
 * - Keyboard: ArrowLeft = back, ArrowRight / Enter = next
 *
 * On the last step, advancing calls `finishOnboarding()` from the UI store.
 */
export function Onboarding() {
  const finishOnboarding = useUIStore((s) => s.finishOnboarding);
  const [step, setStep] = useState<number>(0);

  const last = STEPS.length - 1;
  const isFirst = step === 0;
  const isLast = step === last;
  // WhatsNew (step 2) renders its own Continue button to match the
  // Welcome/Demo pattern, so we hide the chrome there too.
  const isWhatsNew = STEPS[step] === 'whats-new';
  const showChrome = !isFirst && !isLast && !isWhatsNew;

  function goNext() {
    if (isLast) {
      finishOnboarding();
      return;
    }
    setStep((s) => Math.min(last, s + 1));
  }

  function goBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  // Keyboard navigation. We avoid stealing keys when an input is focused so
  // typing in the provider key fields still works, and skip Enter when a
  // button is focused so its native click handler runs untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isInput) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Enter') {
        if (target?.tagName === 'BUTTON') return;
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // step is the only mutable state we read in goNext/goBack closures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col" role="dialog" aria-label="Onboarding">
      <header className="flex items-center justify-center pt-6 pb-2 shrink-0">
        <ProgressDots total={STEPS.length} current={step} onSelect={(i) => i <= step && setStep(i)} />
      </header>

      <div className="flex-1 min-h-0 relative overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={STEPS[step]}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.7 }}
            className="absolute inset-0"
          >
            {step === 0 && <Welcome onNext={goNext} />}
            {step === 1 && <Persona />}
            {step === 2 && <WhatsNew onNext={goNext} />}
            {step === 3 && <Providers onSkip={goNext} />}
            {step === 4 && <Permissions />}
            {step === 5 && <Demo onFinish={finishOnboarding} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {showChrome && (
        <footer className="flex items-center justify-between gap-2 px-8 py-4 shrink-0 border-t border-border bg-panel/60 backdrop-blur-sm">
          <Button variant="ghost" size="sm" onClick={goBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <span className="hidden sm:inline-flex items-center gap-1.5 text-metadata text-muted-foreground">
            <span className="kbd font-mono">{'\u2190'}</span>
            <span className="kbd font-mono">{'\u2192'}</span>
            to navigate
            <span className="mx-2 opacity-50">{'\u00b7'}</span>
            <span className="kbd font-mono">Enter</span>
            to advance
          </span>
          <Button variant="accent" size="sm" onClick={goNext}>
            Next
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </footer>
      )}

      {/* Screen-reader-only live region announcing the current step */}
      <span className="sr-only" aria-live="polite">
        Step {step + 1} of {STEPS.length}: {STEP_LABELS[STEPS[step]]}
      </span>
    </div>
  );
}

interface ProgressDotsProps {
  total: number;
  current: number;
  onSelect: (i: number) => void;
}

function ProgressDots({ total, current, onSelect }: ProgressDotsProps) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Onboarding progress">
      {Array.from({ length: total }, (_, i) => {
        const completed = i < current;
        const active = i === current;
        const reachable = i <= current;
        return (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`Step ${i + 1}`}
            tabIndex={reachable ? 0 : -1}
            disabled={!reachable}
            onClick={() => onSelect(i)}
            className={cn(
              'h-1.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              active
                ? 'w-8 bg-accent-gradient'
                : completed
                  ? 'w-1.5 bg-accent-cyan/60 hover:bg-accent-cyan'
                  : 'w-1.5 bg-border-mid',
              reachable ? 'cursor-pointer' : 'cursor-default',
            )}
          />
        );
      })}
    </div>
  );
}
