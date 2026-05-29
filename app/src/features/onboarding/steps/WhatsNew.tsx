import { motion } from 'motion/react';
import {
  ArrowRight,
  BarChart3,
  Bot,
  History,
  KanbanSquare,
  Sparkles,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WhatsNewProps {
  onNext: () => void;
}

interface FeatureCard {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Text to type into the Jarvis Assistant after Mod+J. Omit for the
   *  Assistant card itself (the hotkey is the feature). */
  command?: string;
}

const CARDS: FeatureCard[] = [
  {
    icon: Terminal,
    title: 'Real terminals',
    description: 'Up to 16 splittable PTYs. The actual ones, not pretend.',
    command: 'open 4 terminals',
  },
  {
    icon: KanbanSquare,
    title: 'Kanban tasks',
    description: 'Drag tasks across todo / in progress / done.',
    command: 'open kanban',
  },
  {
    icon: Sparkles,
    title: 'Skills + agents',
    description:
      'Drop .md files into ~/.jarvis/skills/ and they show up in the library.',
    command: 'open skills',
  },
  {
    icon: BarChart3,
    title: 'Live benchmarks',
    description:
      'See the public Chatbot Arena scores. BYOK to run any of them.',
    command: 'open benchmarks',
  },
  {
    icon: History,
    title: 'Session history',
    description: 'Replay any past chat with a scrubber.',
    command: 'open history',
  },
  {
    icon: Bot,
    title: 'Jarvis Assistant',
    description: 'Local NL command bar. No network, no AI, just regex magic.',
  },
];

/**
 * Onboarding — "What's new in V3" step.
 *
 * Sits between Persona and Providers. Highlights the six BridgeMind-class
 * additions (terminals, kanban, skills/agents, benchmarks, history, the
 * NL assistant) without hijacking the 60-second flow. Each card teaches a
 * Mod+J phrase so users can reach the feature via the assistant later.
 *
 * The chrome footer is hidden while this step is active (see
 * `Onboarding.tsx`); we render our own Continue button that matches the
 * chrome accent style.
 */
export function WhatsNew({ onNext }: WhatsNewProps) {
  return (
    <div className="h-full w-full flex flex-col px-6 sm:px-8 py-6 sm:py-8 gap-6 overflow-y-auto">
      <header className="text-center max-w-2xl mx-auto shrink-0">
        <span className="eyebrow block">What&apos;s new</span>
        <h2 className="font-display text-hero leading-tight mt-2">
          Jarvis V3{' '}
          <span className="text-muted-foreground/60 font-light">·</span>{' '}
          Cozy Workspace
        </h2>
      </header>

      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.05 } },
        }}
        className="grid grid-cols-2 md:grid-cols-3 gap-4 max-w-5xl w-full mx-auto"
      >
        {CARDS.map((card) => (
          <FeatureCardItem key={card.title} card={card} />
        ))}
      </motion.div>

      {/* Pushes footer to the bottom when the viewport has extra space. */}
      <div className="flex-1 min-h-2" />

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 max-w-5xl w-full mx-auto">
        <div className="cozy-toast-success text-center sm:text-left">
          All free. BYOK to use the big providers.
        </div>
        <Button variant="accent" size="sm" onClick={onNext}>
          Continue
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function FeatureCardItem({ card }: { card: FeatureCard }) {
  const Icon = card.icon;
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0 },
      }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className={cn(
        'cozy-card flex flex-col gap-3',
        // Copper hover ring + matching border. The base cozy-card transition
        // already animates box-shadow + border-color, so this composes cleanly.
        'hover:border-accent-copper/60',
        'hover:ring-2 hover:ring-accent-copper/30',
      )}
    >
      <Icon className="h-6 w-6 text-accent-copper" strokeWidth={1.5} />

      <div className="flex flex-col gap-1.5">
        <h3 className="font-display text-page-title text-foreground leading-tight">
          {card.title}
        </h3>
        <p className="text-secondary text-muted-foreground leading-snug">
          {card.description}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-metadata text-muted-foreground pt-1">
        <span className="kbd font-mono">Mod+J</span>
        {card.command && (
          <>
            <span className="opacity-60">·</span>
            <span className="font-mono italic text-foreground/80">
              &ldquo;{card.command}&rdquo;
            </span>
          </>
        )}
      </div>
    </motion.div>
  );
}
