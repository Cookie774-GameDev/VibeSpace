import { motion, AnimatePresence } from 'motion/react';
import { forwardRef } from 'react';
import {
  X,
  FileText,
  Network,
  Zap,
  Terminal,
  Image,
  Link,
  Folder,
  Plug,
  UserRound,
} from 'lucide-react';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { cn } from '@/lib/utils';

export type TokenType =
  | 'command'
  | 'file'
  | 'contextmap'
  | 'terminal'
  | 'image'
  | 'link'
  | 'folder'
  | 'model'
  | 'agent'
  | 'plugin';

export interface InputTokenProps {
  type: TokenType;
  label: string;
  sublabel?: string;
  /** Replaces the default type icon (e.g. official plugin logo). */
  icon?: React.ReactNode;
  onActivate?: () => void;
  onRemove?: () => void;
  className?: string;
}

const TOKEN_ICONS: Record<TokenType, typeof FileText> = {
  command: Zap,
  file: FileText,
  contextmap: Network,
  terminal: Terminal,
  image: Image,
  link: Link,
  folder: Folder,
  model: Zap,
  agent: UserRound,
  plugin: Plug,
};

const TOKEN_COLORS: Record<TokenType, string> = {
  command: 'from-amber-400/30 via-orange-500/25 to-rose-500/30 border-amber-400/55',
  file: 'from-blue-500/25 to-indigo-500/25 border-blue-500/40',
  contextmap: 'from-purple-500/30 to-fuchsia-500/30 border-purple-500/50',
  terminal: 'from-emerald-500/25 to-teal-500/25 border-emerald-500/40',
  image: 'from-pink-500/25 to-rose-500/25 border-pink-500/40',
  link: 'from-cyan-500/25 to-sky-500/25 border-cyan-500/40',
  folder: 'from-amber-500/25 to-orange-500/25 border-amber-500/40',
  model: 'from-violet-500/30 to-purple-600/30 border-violet-500/50',
  agent: 'from-cyan-400/25 via-sky-500/20 to-blue-500/25 border-cyan-400/45',
  plugin: 'from-orange-500/25 to-amber-500/25 border-orange-500/40',
};

const TOKEN_GLOW: Record<TokenType, string> = {
  command: 'shadow-[0_0_14px_rgba(245,158,11,0.28)]',
  file: 'shadow-[0_0_10px_rgba(59,130,246,0.2)]',
  contextmap: 'shadow-[0_0_12px_rgba(168,85,247,0.3)]',
  terminal: 'shadow-[0_0_10px_rgba(16,185,129,0.2)]',
  image: 'shadow-[0_0_10px_rgba(236,72,153,0.2)]',
  link: 'shadow-[0_0_10px_rgba(6,182,212,0.2)]',
  folder: 'shadow-[0_0_10px_rgba(245,158,11,0.2)]',
  model: 'shadow-[0_0_12px_rgba(139,92,246,0.3)]',
  agent: 'shadow-[0_0_12px_rgba(34,211,238,0.24)]',
  plugin: 'shadow-[0_0_10px_rgba(245,158,11,0.2)]',
};
const SPRING = 'spring' as const;
const TOKEN_TRANSITION = { type: SPRING, stiffness: 520, damping: 26, mass: 0.7 };

export const InputToken = forwardRef<HTMLDivElement, InputTokenProps>(function InputToken(
  { type, label, sublabel, icon, onActivate, onRemove, className },
  ref,
) {
  const Icon = TOKEN_ICONS[type];
  const isCommand = type === 'command';
  const tokenTransition = useThemeMotionTransition(TOKEN_TRANSITION);
  const filterTransition =
    'duration' in tokenTransition && tokenTransition.duration === 0
      ? { duration: 0 }
      : { type: 'tween' as const, duration: 0.18, ease: 'easeOut' as const };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.72, y: 8, filter: 'blur(2px)' }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.85, y: -6, filter: 'blur(1px)' }}
      transition={{ ...tokenTransition, filter: filterTransition }}
      data-slash-active-glow={isCommand ? 'true' : undefined}
      className={cn(
        'relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'bg-gradient-to-r border',
        'text-metadata font-medium',
        TOKEN_COLORS[type],
        TOKEN_GLOW[type],
        isCommand &&
          'jarvis-confirmed-token animate-[plan-border-flow_5.5s_linear_infinite] bg-[length:240%_auto] shadow-[0_0_18px_rgba(245,158,11,0.35),inset_0_0_12px_rgba(251,191,36,0.12)] ring-1 ring-amber-400/40',
        type === 'agent' && 'jarvis-agent-token',
        type === 'file' && 'ring-1 ring-blue-400/25',
        'hover:brightness-110 transition-all duration-200',
        className,
      )}
      title={isCommand ? `Confirmed: ${label}` : label}
    >
      {isCommand ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
        >
          <span className="absolute inset-y-0 -left-1/3 w-1/3 skew-x-[-18deg] bg-gradient-to-r from-transparent via-white/25 to-transparent animate-[plan-border-flow_2.4s_linear_infinite] bg-[length:200%_auto]" />
        </span>
      ) : null}
      {onActivate ? (
        <button
          type="button"
          className="relative inline-flex min-w-0 items-center gap-1.5 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500"
          onClick={onActivate}
          aria-label={`Preview ${label}`}
        >
          {icon ?? (
            <Icon
              className={cn(
                'relative h-3 w-3 shrink-0',
                type === 'agent' ? 'text-cyan-300' : 'text-violet-400',
              )}
            />
          )}
          <span className="relative max-w-[140px] truncate text-foreground/95">{label}</span>
          {sublabel ? (
            <span className="relative max-w-[90px] truncate text-muted-foreground/75">
              {sublabel}
            </span>
          ) : null}
        </button>
      ) : (
        <>
          {icon ?? (
            <Icon
              className={cn(
                'relative h-3 w-3 shrink-0',
                isCommand
                  ? 'text-amber-200 drop-shadow-[0_0_6px_rgba(251,191,36,0.8)]'
                  : type === 'agent'
                    ? 'text-cyan-300'
                    : 'text-violet-400',
              )}
            />
          )}
          <span className="relative max-w-[140px] truncate text-foreground/95">{label}</span>
          {sublabel ? (
            <span className="relative max-w-[90px] truncate text-muted-foreground/75">
              {sublabel}
            </span>
          ) : null}
        </>
      )}
      {isCommand ? (
        <span className="relative rounded-full bg-amber-400/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-200/95">
          ok
        </span>
      ) : null}
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className={cn(
            'relative ml-0.5 p-0.5 rounded-full',
            'text-muted-foreground/60 hover:text-foreground',
            'hover:bg-white/10 transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500',
          )}
          aria-label={`Remove ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </motion.div>
  );
});

export interface TokenListProps {
  children: React.ReactNode;
  className?: string;
}

export function TokenList({ children, className }: TokenListProps) {
  return (
    <div className={cn('flex flex-wrap gap-1.5 items-center', className)}>
      <AnimatePresence mode="popLayout">{children}</AnimatePresence>
    </div>
  );
}

export default InputToken;
