import { motion } from 'motion/react';
import { Mic, Plus } from 'lucide-react';
import { Button } from '@/components/ui';
import { renderHotkey } from '@/lib/utils';
import { HOTKEYS } from '@/lib/hotkeys';

export interface EmptyChatProps {
  /** Override the default new-chat handler. */
  onNewChat?: () => void;
}

const spring = { type: 'spring' as const, stiffness: 400, damping: 30, mass: 0.8 };

/**
 * Shown when there is no active chat. Mirrors docs/05-ui-ux-design.md section 9:
 * a single soft illustration, a calm headline, encouraging body, and one primary action.
 */
export function EmptyChat({ onNewChat }: EmptyChatProps) {
  const handleNewChat = () => {
    if (onNewChat) {
      onNewChat();
      return;
    }
    window.dispatchEvent(new CustomEvent('jarvis:new-chat'));
  };

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="flex flex-col items-center gap-5 text-center max-w-[44ch]"
      >
        <div
          className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-elevated"
          style={{
            backgroundImage:
              'radial-gradient(ellipse at center, hsl(var(--accent-cyan) / 0.12), transparent 70%)',
          }}
        >
          <Mic className="h-7 w-7 text-accent-cyan" />
        </div>

        <div className="flex flex-col gap-1.5">
          <h2 className="text-page-title text-foreground">Jarvis is ready.</h2>
          <p className="text-body text-muted-foreground">
            Try saying{' '}
            <span className="text-foreground">
              "Hey Jarvis, what can you do?"
            </span>{' '}
            or start a fresh chat below.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="accent" onClick={handleNewChat}>
            <Plus />
            New chat
          </Button>
          <span className="text-metadata text-muted-foreground">
            <span className="kbd">{renderHotkey(HOTKEYS.NEW_CHAT)}</span>
          </span>
        </div>
      </motion.div>
    </div>
  );
}
