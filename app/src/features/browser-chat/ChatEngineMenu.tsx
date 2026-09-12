import * as React from 'react';
import { Check, MessagesSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { resolveChatEngine, useBrowserChatStore } from './browserChatStore';
import {
  CHAT_ENGINE_OPTIONS,
  transitionChatEngine,
  type ChatEngineTransitionInput,
  type ChatEngineTransitionResult,
} from './chatEngineTransition';

interface ChatEngineMenuProps {
  readonly onNavigateChat?: () => void;
  readonly className?: string;
  readonly transitionEngine?: (
    input: ChatEngineTransitionInput,
  ) => Promise<ChatEngineTransitionResult>;
}

export function ChatEngineMenu({
  onNavigateChat,
  className,
  transitionEngine = transitionChatEngine,
}: ChatEngineMenuProps) {
  const activeChatId = useUIStore((state) => state.activeChatId);
  const engine = useBrowserChatStore((state) => resolveChatEngine(state, activeChatId));
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Chat modes · ${engine === 'native' ? 'VibeSpace Chat' : 'Browser Chat'}`}
          aria-expanded={open}
          aria-pressed={engine === 'browser'}
          className={cn('min-h-6 min-w-6 shrink-0', className)}
        >
          <MessagesSquare className="h-4 w-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-1.5">
        <div className="px-2 pb-1.5 pt-1">
          <p className="text-xs font-semibold text-foreground">Chat modes</p>
          <p className="text-[11px] text-muted-foreground">
            Switch engines without changing your selected native model.
          </p>
        </div>
        <div role="menu" aria-label="Chat modes" className="space-y-1">
          {CHAT_ENGINE_OPTIONS.map((option) => {
            const active = option.id === engine;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={busy || !activeChatId}
                onClick={() => {
                  if (!activeChatId || busy) return;
                  setBusy(true);
                  void transitionEngine({
                    chatId: activeChatId,
                    targetEngine: option.id,
                  }).then((result) => {
                    if (result.status !== 'failed') {
                      if (result.chatId !== activeChatId) {
                        useUIStore.getState().setActiveChat(result.chatId);
                      }
                      onNavigateChat?.();
                      setOpen(false);
                    }
                    setBusy(false);
                  });
                }}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
                  'hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/60',
                  active && 'bg-muted/80',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border',
                    active
                      ? 'border-accent-copper bg-accent-copper/15 text-accent-copper'
                      : 'border-border text-transparent',
                  )}
                >
                  <Check className="h-3 w-3" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
