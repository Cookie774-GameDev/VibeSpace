import { Code2, FileText, MessageSquare, Users } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useUIStore, type ChatMode } from '@/stores/ui';

export interface CouncilToggleProps {
  /** Optional className for the wrapping Tabs root */
  className?: string;
}

const MODES: ReadonlyArray<{ id: ChatMode; label: string; icon: typeof MessageSquare }> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'council', label: 'Council', icon: Users },
  { id: 'doc', label: 'Doc', icon: FileText },
  { id: 'code', label: 'Code', icon: Code2 },
];

function isMode(value: string): value is ChatMode {
  return value === 'chat' || value === 'council' || value === 'doc' || value === 'code';
}

/**
 * Segmented control for switching the main canvas between chat, council,
 * doc, and code modes. Bound to `useUIStore.chatMode`.
 *
 * Place anywhere in the canvas header. Width is intrinsic so it fits in
 * tight toolbars.
 */
export function CouncilToggle({ className }: CouncilToggleProps) {
  const mode = useUIStore((s) => s.chatMode);
  const setMode = useUIStore((s) => s.setChatMode);

  return (
    <Tabs
      value={mode}
      onValueChange={(v) => {
        if (isMode(v)) setMode(v);
      }}
      className={cn('inline-flex', className)}
    >
      <TabsList>
        {MODES.map(({ id, label, icon: Icon }) => (
          <TabsTrigger key={id} value={id} aria-label={`${label} mode`}>
            <Icon className="size-3.5" />
            <span>{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
