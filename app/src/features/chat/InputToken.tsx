import { motion, AnimatePresence } from 'motion/react';
import { X, FileText, Network, Zap, Terminal, Clock, Image, Link, Folder } from 'lucide-react';
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
  | 'agent';

export interface InputTokenProps {
  type: TokenType;
  label: string;
  sublabel?: string;
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
  agent: Zap,
};

const TOKEN_COLORS: Record<TokenType, string> = {
  command: 'from-violet-500/30 to-purple-600/30 border-violet-500/50',
  file: 'from-blue-500/25 to-indigo-500/25 border-blue-500/40',
  contextmap: 'from-purple-500/30 to-fuchsia-500/30 border-purple-500/50',
  terminal: 'from-emerald-500/25 to-teal-500/25 border-emerald-500/40',
  image: 'from-pink-500/25 to-rose-500/25 border-pink-500/40',
  link: 'from-cyan-500/25 to-sky-500/25 border-cyan-500/40',
  folder: 'from-amber-500/25 to-orange-500/25 border-amber-500/40',
  model: 'from-violet-500/30 to-purple-600/30 border-violet-500/50',
  agent: 'from-violet-500/30 to-purple-600/30 border-violet-500/50',
};

const TOKEN_GLOW: Record<TokenType, string> = {
  command: 'shadow-[0_0_12px_rgba(139,92,246,0.3)]',
  file: 'shadow-[0_0_10px_rgba(59,130,246,0.2)]',
  contextmap: 'shadow-[0_0_12px_rgba(168,85,247,0.3)]',
  terminal: 'shadow-[0_0_10px_rgba(16,185,129,0.2)]',
  image: 'shadow-[0_0_10px_rgba(236,72,153,0.2)]',
  link: 'shadow-[0_0_10px_rgba(6,182,212,0.2)]',
  folder: 'shadow-[0_0_10px_rgba(245,158,11,0.2)]',
  model: 'shadow-[0_0_12px_rgba(139,92,246,0.3)]',
  agent: 'shadow-[0_0_12px_rgba(139,92,246,0.3)]',
};

export function InputToken({ type, label, sublabel, onRemove, className }: InputTokenProps) {
  const Icon = TOKEN_ICONS[type];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: -4 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'bg-gradient-to-r border',
        'text-metadata font-medium',
        TOKEN_COLORS[type],
        TOKEN_GLOW[type],
        'hover:brightness-110 transition-all duration-200',
        className,
      )}
    >
      <Icon className="h-3 w-3 text-violet-400 shrink-0" />
      <span className="text-foreground/90 truncate max-w-[120px]">{label}</span>
      {sublabel && (
        <span className="text-muted-foreground/70 truncate max-w-[80px]">{sublabel}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'ml-0.5 p-0.5 rounded-full',
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
}

export interface TokenListProps {
  children: React.ReactNode;
  className?: string;
}

export function TokenList({ children, className }: TokenListProps) {
  return (
    <div className={cn('flex flex-wrap gap-1.5 items-center', className)}>
      <AnimatePresence mode="popLayout">
        {children}
      </AnimatePresence>
    </div>
  );
}

export default InputToken;
