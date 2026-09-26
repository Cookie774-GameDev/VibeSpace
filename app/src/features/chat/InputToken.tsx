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
  BookOpen,
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
  | 'plugin'
  | 'native-skill';

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
  'native-skill': BookOpen,
};

const SPRING = 'spring' as const;
const TOKEN_TRANSITION = { type: SPRING, stiffness: 520, damping: 26, mass: 0.7 };

export const InputToken = forwardRef<HTMLDivElement, InputTokenProps>(function InputToken(
  { type, label, sublabel, icon, onActivate, onRemove, className },
  ref,
) {
  const Icon = TOKEN_ICONS[type];
  const isCommand = type === 'command';
  const isNativeSkill = type === 'native-skill';
  const isSkill = isNativeSkill || (isCommand && /^\/skills(?::|\b)/iu.test(label.trim()));
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
      data-composer-token-theme="native"
      data-composer-token-kind={isNativeSkill ? 'native-skill' : isSkill ? 'skill' : type}
      className={cn(
        'relative inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/80 bg-muted/65 px-2 py-0.5',
        'text-[11px] font-medium leading-4 text-foreground/90',
        isCommand && !isSkill && 'border-accent-copper/35 bg-accent-copper/10',
        isSkill &&
          'gap-1 border-border/55 bg-muted/45 px-1.5 text-foreground/82 hover:border-border/80 hover:bg-muted/60',
        isNativeSkill && 'border-sky-500/45 bg-sky-500/12 text-sky-800 dark:text-sky-200',
        'transition-colors duration-150 hover:border-foreground/20 hover:bg-muted/85',
        className,
      )}
      title={isNativeSkill ? `Native CLI skill selected: ${label}` : isSkill ? `Attached skill: ${label}` : isCommand ? `Confirmed: ${label}` : label}
    >
      {onActivate ? (
        <button
          type="button"
          className="relative inline-flex min-w-0 items-center gap-1.5 rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onActivate}
          aria-label={`Preview ${label}`}
        >
          {icon ?? (
            <Icon
              className={cn(
                'relative h-3 w-3 shrink-0',
                isCommand && !isSkill ? 'text-accent-copper' : 'text-muted-foreground',
              )}
            />
          )}
          <span className="relative max-w-[180px] truncate">{label}</span>
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
                isCommand && !isSkill ? 'text-accent-copper' : 'text-muted-foreground',
              )}
            />
          )}
          <span className="relative max-w-[180px] truncate">{label}</span>
          {sublabel ? (
            <span className="relative max-w-[90px] truncate text-muted-foreground/75">
              {sublabel}
            </span>
          ) : null}
        </>
      )}
      {isCommand && !isSkill ? (
        <span className="relative rounded-sm bg-accent-copper/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-accent-copper">
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
            'relative ml-0.5 rounded-sm p-0.5',
            'text-muted-foreground/60 hover:text-foreground',
            'hover:bg-foreground/5 transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
