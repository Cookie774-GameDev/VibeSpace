import { useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useCallStore } from './store';
import { getCallService } from './CallService';
import { useUIStore } from '@/stores/ui';

/**
 * Call button — drops into the TopBar.
 *
 * Two modes:
 *  - idle: shows a small green Phone icon. Click opens the CallModal which
 *          starts the call.
 *  - active call: shows a red PhoneOff icon. Click hangs up immediately.
 *
 * Disabled (with tooltip) when:
 *  - cloud URL is not configured (operator hasn't deployed phone-jarvis yet)
 *  - user is not signed into Supabase
 */
export function CallButton({ compact = false }: { compact?: boolean }) {
  const status = useCallStore((s) => s.status);
  const setCallModalOpen = useUIStore((s) => s.setCallModalOpen);
  const callModalOpen = useUIStore((s) => s.callModalOpen);

  const inCall = status !== 'idle';
  const service = getCallService();
  const configured = service.isConfigured();

  // Open modal automatically when status flips out of idle
  useEffect(() => {
    if (inCall && !callModalOpen) {
      setCallModalOpen(true);
    }
  }, [inCall, callModalOpen, setCallModalOpen]);

  const handleClick = () => {
    if (!configured) {
      toast.info('Phone & Voice not set up', 'Open Settings → Phone & Voice to point Jarvis at the phone-jarvis cloud.');
      return;
    }
    if (inCall) {
      void service.stop();
      setCallModalOpen(false);
      return;
    }
    setCallModalOpen(true);
  };

  const label = inCall ? 'Hang up' : 'Call Sage';
  const Icon = inCall ? PhoneOff : Phone;

  return (
    <TooltipProvider delayDuration={500}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClick}
            aria-label={label}
            className={cn(
              compact ? 'h-8 w-8' : 'h-9 w-9',
              inCall && 'text-rose-500 hover:text-rose-400',
              !inCall && configured && 'text-emerald-500 hover:text-emerald-400',
              !configured && 'text-muted-foreground/50',
            )}
          >
            <Icon className={cn(compact ? 'h-4 w-4' : 'h-[18px] w-[18px]')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {configured ? label : 'Phone & Voice not configured'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
