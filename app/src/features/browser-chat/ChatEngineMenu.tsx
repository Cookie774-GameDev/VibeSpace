import * as React from 'react';
import { Check, MessagesSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { useBrowserChatStore, type VibeSpaceChatEngine } from './browserChatStore';

interface ChatEngineMenuProps {
  readonly onNavigateChat?: () => void;
  readonly className?: string;
}

const ENGINES: ReadonlyArray<{
  id: VibeSpaceChatEngine;
  label: string;
  description: string;
}> = [
  {
    id: 'native',
    label: 'VibeSpace Chat',
    description: 'Models, local AI, agents, files, tools, voice, and Prompt Forge.',
  },
  {
    id: 'browser',
    label: 'Browser Chat',
    description: 'Real ChatGPT in an isolated VibeSpace browser surface.',
  },
];

export function ChatEngineMenu({ onNavigateChat, className }: ChatEngineMenuProps) {
  const activeChatId = useUIStore((state) => state.activeChatId);
  const engine = useBrowserChatStore(
    (state) => state.chatPreferences[activeChatId ?? '']?.engine ?? state.engine,
  );
  const setEngine = useBrowserChatStore((state) => state.setEngine);
  const [open, setOpen] = React.useState(false);

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
          {ENGINES.map((option) => {
            const active = option.id === engine;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setEngine(option.id, activeChatId);
                  onNavigateChat?.();
                  setOpen(false);
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
