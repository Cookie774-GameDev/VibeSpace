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
import { isAdminIdentity, planAllowsJarvisCall } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth';
import { useCallStore } from './store';
import { isCallConfigured } from './config';
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
 *
 * Bundle policy:
 *   This module is reachable from the eagerly-loaded TopBar via the
 *   `@/features/call` barrel. We deliberately do NOT statically import
 *   `./CallService` here — that file pulls in `livekit-client` (~500KB)
 *   AND `@/lib/supabase/client` (~210KB), and a static import would put
 *   both on the initial-load critical path even for users who never make
 *   a call. Instead:
 *     - `isCallConfigured()` is an env-only check from `./config`.
 *     - The actual `service.stop()` call (only fires when `inCall === true`,
 *       at which point the LiveKit chunk is already loaded by CallModal)
 *       goes through a dynamic `import('./CallService')`.
 */
export function CallButton({ compact = false }: { compact?: boolean }) {
  const status = useCallStore((s) => s.status);
  const setCallModalOpen = useUIStore((s) => s.setCallModalOpen);
  const callModalOpen = useUIStore((s) => s.callModalOpen);
  const plan = useAuthStore((s) => s.plan);
  const email = useAuthStore((s) => s.email);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email);
  const localUserId = useAuthStore((s) => s.localUserId);

  const inCall = status !== 'idle';
  const configured = isCallConfigured();
  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const entitled = planAllowsJarvisCall(plan, admin);

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
    if (!entitled) {
      toast.warning('Jarvis Call requires a plan', 'Upgrade to a voice-enabled plan or use an admin-enabled build.');
      return;
    }
    if (inCall) {
      // CallModal already loaded the LiveKit chunk to start the call;
      // this dynamic import is just a cheap re-resolve of the same module.
      void import('./CallService').then((m) => m.getCallService().stop());
      setCallModalOpen(false);
      return;
    }
    setCallModalOpen(true);
  };

  const label = inCall ? 'Hang up' : 'Call Jarvis';
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
              !inCall && configured && entitled && 'text-emerald-500 hover:text-emerald-400',
              (!configured || !entitled) && 'text-muted-foreground/50',
            )}
          >
            <Icon className={cn(compact ? 'h-4 w-4' : 'h-[18px] w-[18px]')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {!configured ? 'Phone & Voice not configured' : entitled ? label : 'Jarvis Call requires a voice plan'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
