import * as React from 'react';
import { Network, Play, RefreshCw, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import {
  terminalPeerFabricCommandPort,
  type TerminalPeerFabricCommandPort,
} from './terminalPeerFabricTool';
import { useFabricPresentationStore } from './fabricPresentationStore';

type CapabilityState = 'checking' | 'available' | 'unavailable';

export type TerminalPeerFabricToolCardProps = Readonly<{
  port?: TerminalPeerFabricCommandPort;
  eligibleTerminalCount?: number;
  onOpen?: () => void;
  onManage?: () => void;
}>;

export function TerminalPeerFabricToolCard({
  port = terminalPeerFabricCommandPort,
  eligibleTerminalCount,
  onOpen,
  onManage,
}: TerminalPeerFabricToolCardProps) {
  const connectedCount = useFabricPresentationStore((state) => state.peers.length);
  const [capability, setCapability] = React.useState<CapabilityState>('checking');
  const [discoveredCount, setDiscoveredCount] = React.useState(eligibleTerminalCount ?? 0);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);

  React.useEffect(() => {
    let active = true;
    setCapability('checking');
    const probe = window.setTimeout(() => {
      void port
        .capability(revision > 0)
        .then((result) => {
          if (active) {
            setCapability(
              result.available && result.operations?.includes('connect')
                ? 'available'
                : 'unavailable',
            );
          }
        })
        .catch(() => {
          if (active) setCapability('unavailable');
        });
      if (eligibleTerminalCount == null) {
        void readLiveTargetSnapshot()
          .then((targets) => {
            if (active) setDiscoveredCount(targets.length);
          })
          .catch(() => {
            if (active) setDiscoveredCount(0);
          });
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(probe);
    };
  }, [eligibleTerminalCount, port, revision]);

  const count = eligibleTerminalCount ?? discoveredCount;
  // This opens selection; only Confirm performs the native connection.
  // A cached count must not prevent users from reaching their terminal panes.
  const canRun = capability === 'available';
  const status =
    capability === 'checking'
      ? 'Checking native capability…'
      : capability === 'unavailable'
        ? 'Not available in this build.'
        : count < 2
          ? 'Open terminals to choose at least two live panes.'
          : `${count} eligible terminals ready.`;

  return (
    <article className="flex min-h-36 items-center gap-4 rounded-lg border border-accent-copper/35 bg-gradient-to-br from-paper to-accent-copper/10 px-4 py-4 shadow-soft">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-accent-copper/35 bg-accent-copper/15">
        <Network className="h-5 w-5 text-accent-copper" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">Terminal Peer Fabric</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          Connect VibeSpace terminals as one capability-gated team. Preloaded; no separate install.
        </span>
        <span className="mt-1 block text-xs text-muted-foreground" role="status">
          {status}
        </span>
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Refresh Terminal Peer Fabric availability"
        title="Recheck native capability and eligible terminals"
        disabled={capability === 'checking'}
        onClick={refresh}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${capability === 'checking' ? 'animate-spin' : ''}`} />
      </Button>
      {connectedCount > 1 && <Button type="button" size="sm" variant="outline" onClick={onManage}
        aria-label="Manage Terminal Peer Fabric">
        <PanelRightOpen className="h-3.5 w-3.5" /> Manage
      </Button>}
      <Button
        type="button"
        size="sm"
        disabled={!canRun}
        onClick={onOpen}
        aria-label="Run Terminal Peer Fabric"
      >
        <Play className="h-3.5 w-3.5" /> Run
      </Button>
    </article>
  );
}
