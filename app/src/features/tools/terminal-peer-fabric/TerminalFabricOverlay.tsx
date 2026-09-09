import * as React from 'react';
import { Link2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import type { LiveTerminalTarget } from '@/features/instant-command/types';
import { terminalPeerFabricCommandPort as port } from './terminalPeerFabricTool';
import { sameFabricMembers, useFabricPresentationStore } from './fabricPresentationStore';
import './terminal-fabric.css';

type Box = { id: string; x: number; y: number; width: number; height: number };
export function TerminalFabricOverlay({
  visible,
  projectId,
}: {
  visible: boolean;
  projectId: string | null;
}) {
  const selecting = useFabricPresentationStore((s) => s.selecting);
  const peers = useFabricPresentationStore((s) => s.peers);
  const delivery = useFabricPresentationStore((s) => s.delivery);
  const [targets, setTargets] = React.useState<LiveTerminalTarget[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [boxes, setBoxes] = React.useState<Box[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [verified, setVerified] = React.useState<string[]>([]);
  const epoch = React.useRef(0);
  const submitting = React.useRef(false);
  const picker = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    if (!delivery) return;
    // Expire receipts even when animation events are suppressed (reduced motion,
    // hidden route, or an unmounted SVG).
    const timer = window.setTimeout(() => {
      if (useFabricPresentationStore.getState().delivery?.id === delivery.id)
        useFabricPresentationStore.setState({ delivery: null });
    }, 700);
    return () => clearTimeout(timer);
  }, [delivery]);

  React.useEffect(() => {
    epoch.current++;
    setSelected([]);
    setError(null);
    setBusy(false);
    submitting.current = false;
    if (selecting && visible) picker.current?.focus();
    if (!visible) useFabricPresentationStore.getState().close();
    return () => {
      epoch.current++;
    };
  }, [selecting, projectId, visible]);

  React.useEffect(() => {
    if (!visible || (!selecting && peers.length === 0)) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const live = await readLiveTargetSnapshot();
        if (!active) return;
        setTargets(live.filter((t) => t.projectId === projectId));
        if (peers.length) {
          const result = await port.command({
            commandId: 'team.status',
            correlationId: crypto.randomUUID(),
            targetIds: [],
          });
          if (active) setVerified(result.status === 'completed' ? [...result.targetIds] : []);
        }
      } catch {
        if (active) setVerified([]);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible, selecting, peers, projectId]);

  React.useLayoutEffect(() => {
    if (!visible) return;
    const panes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-terminal-drop-pane-id]'),
    );
    const update = () =>
      setBoxes(
        panes.flatMap((pane) => {
          const id = pane.dataset.terminalDropPaneId ?? '';
          if (!targets.some((t) => t.paneId === id)) return [];
          const r = pane.getBoundingClientRect();
          return r.width > 0 && r.height > 0
            ? [{ id, x: r.x, y: r.y, width: r.width, height: r.height }]
            : [];
        }),
      );
    update();
    const observer = new ResizeObserver(update);
    panes.forEach((pane) => observer.observe(pane));
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [targets, visible]);

  React.useEffect(() => {
    if (!selecting) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting.current) {
        event.preventDefault();
        event.stopPropagation();
        useFabricPresentationStore.getState().close();
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [selecting]);

  const confirm = async () => {
    if (submitting.current || selected.length < 2 || selected.length > 8) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const revision = epoch.current;
    try {
      const fresh = await readLiveTargetSnapshot();
      if (revision !== epoch.current) return;
      const chosen = selected.map((id) => {
        const before = targets.find((t) => t.sessionId === id);
        const now = fresh.find((t) => t.sessionId === id && t.projectId === projectId);
        if (
          !before ||
          !now ||
          before.paneId !== now.paneId ||
          before.processIdentity.processInstanceId !== now.processIdentity.processInstanceId ||
          before.processIdentity.runtimeGeneration !== now.processIdentity.runtimeGeneration
        )
          throw Error('A selected terminal changed. Select the live terminals again.');
        return {
          sessionId: id,
          paneId: now.paneId,
          projectId: now.projectId!,
          runtimeGeneration: now.processIdentity.runtimeGeneration,
        };
      });
      const receipt = await port.connect({ correlationId: crypto.randomUUID(), peerRefs: chosen });
      if (revision !== epoch.current) return;
      if (receipt.status !== 'completed' || !sameFabricMembers(receipt.targetIds, selected))
        throw Error('The connection was not confirmed. Try again.');
      setVerified([...receipt.targetIds]);
      useFabricPresentationStore.getState().connected(chosen);
    } catch (cause) {
      if (revision === epoch.current)
        setError(cause instanceof Error ? cause.message : 'Connection failed.');
    } finally {
      if (revision === epoch.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  if (!visible) return null;
  const connected = peers.flatMap((peer) => {
    if (peer.projectId !== projectId) return [];
    const live = targets.find(
      (t) =>
        t.sessionId === peer.sessionId &&
        t.paneId === peer.paneId &&
        t.projectId === peer.projectId &&
        t.processIdentity.runtimeGeneration === peer.runtimeGeneration,
    );
    const box = boxes.find((b) => b.id === peer.paneId);
    return live && box && verified.includes(peer.sessionId) ? [box] : [];
  });
  return (
    <>
      {!selecting && connected.length > 1 && (
        <svg className="vs-fabric-bridges" aria-label={`${connected.length} connected terminals`}>
          {connected.slice(1).map((box, i) => {
            const from = connected[i];
            const x1 = from.x + from.width - 7,
              y1 = from.y + 24;
            const x2 = box.x + 7,
              y2 = box.y + 24;
            return (
              <g key={`${from.id}:${box.id}`}>
                <path
                  d={`M ${x1} ${y1} C ${x1 + 24} ${y1 - 18}, ${x2 - 24} ${y2 - 18}, ${x2} ${y2}`}
                />
                <circle cx={x1} cy={y1} r="3" />
                <circle cx={x2} cy={y2} r="3" />
              </g>
            );
          })}
          {delivery &&
            delivery.to.map((id) => {
              const source = peers.find((p) => p.sessionId === delivery.from);
              const target = peers.find((p) => p.sessionId === id);
              const from = connected.find((b) => b.id === source?.paneId);
              const to = connected.find((b) => b.id === target?.paneId);
              if (!from || !to) return null;
              return (
                <circle
                  className="vs-fabric-spark"
                  key={`${delivery.id}:${id}`}
                  r="3"
                  onAnimationEnd={() => {
                    if (useFabricPresentationStore.getState().delivery?.id === delivery.id)
                      useFabricPresentationStore.setState({ delivery: null });
                  }}
                >
                  <animateMotion
                    dur="650ms"
                    repeatCount="1"
                    path={`M ${from.x + from.width - 7} ${from.y + 24} Q ${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 8} ${to.x + 7} ${to.y + 24}`}
                  />
                </circle>
              );
            })}
        </svg>
      )}
      {selecting && (
        <>
          <section
            ref={picker}
            tabIndex={-1}
            className="vs-fabric-picker"
            aria-label="Connect terminal panes"
          >
            <Link2 aria-hidden size={21} />
            <div>
              <h2>Connect your terminals</h2>
              <p>{targets.length < 2 ? 'Add at least two terminal panes, then select them here.' : 'Choose 2–8 panes. Selected terminals light up.'}</p>
              {error && <p role="alert">{error}</p>}
            </div>
            <span aria-live="polite">{selected.length} / 8</span>
            <Button disabled={busy || selected.length < 2} onClick={() => void confirm()}>
              {busy ? 'Connecting…' : 'Confirm connection'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label="Cancel terminal connection"
              onClick={() => useFabricPresentationStore.getState().close()}
            >
              <X size={16} />
            </Button>
          </section>
          {boxes.map((box) => {
            const target = targets.find((t) => t.paneId === box.id)!;
            const checked = selected.includes(target.sessionId);
            return (
              <button
                key={box.id}
                type="button"
                className="vs-fabric-pane"
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                aria-label={`Connect ${target.label ?? 'terminal'} ${target.ordinal}`}
                aria-pressed={checked}
                disabled={busy || (!checked && selected.length >= 8)}
                onClick={() =>
                  setSelected((ids) =>
                    checked
                      ? ids.filter((id) => id !== target.sessionId)
                      : [...ids, target.sessionId],
                  )
                }
              >
                <span>{checked ? 'Selected' : 'Click to connect'}</span>
              </button>
            );
          })}
        </>
      )}
    </>
  );
}
