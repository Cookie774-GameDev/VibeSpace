import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { PERSONAS } from './personas-data';
import { cn } from '@/lib/utils';

export function Persona() {
  const persona = useAuthStore((s) => s.personaPreset);
  const setPersona = useAuthStore((s) => s.setPersona);

  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 py-10 gap-8 overflow-y-auto">
      <header className="text-center max-w-xl">
        <h2 className="text-hero leading-tight">Pick a personality</h2>
        <p className="text-body text-muted-foreground mt-3">
          You can change this later in Settings - Voice. Each persona has its own tone and a
          matching voice profile.
        </p>
      </header>

      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04 } },
        }}
        className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-3xl w-full"
      >
        {PERSONAS.map((p) => {
          const selected = persona === p.id;
          return (
            <motion.button
              key={p.id}
              type="button"
              variants={{
                hidden: { opacity: 0, y: 8 },
                show: { opacity: 1, y: 0 },
              }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              onClick={() => setPersona(p.id)}
              aria-pressed={selected}
              className={cn(
                'relative flex flex-col items-start gap-2 rounded-lg border bg-panel p-4 text-left transition-colors',
                'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                selected
                  ? 'border-accent-cyan/60 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.5),0_0_24px_-8px_hsl(var(--accent-violet)/0.5)]'
                  : 'border-border',
              )}
            >
              {selected && (
                <span className="absolute right-3 top-3 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-gradient text-white">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              )}
              <span
                className={cn(
                  'text-page-title',
                  selected ? 'text-accent-gradient' : 'text-foreground',
                )}
              >
                {p.name}
              </span>
              <span className="text-secondary text-foreground">{p.tone}</span>
              {p.description && (
                <span className="text-metadata text-muted-foreground line-clamp-2">
                  {p.description}
                </span>
              )}
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
