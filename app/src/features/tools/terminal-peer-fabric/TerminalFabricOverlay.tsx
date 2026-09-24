import * as React from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Link2, MessageSquareText, RefreshCw, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import type { LiveTerminalTarget } from '@/features/instant-command/types';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { terminalPeerFabricCommandPort as port } from './terminalPeerFabricTool';
import { recordFabricDelivery, sameFabricMembers, useFabricPresentationStore } from './fabricPresentationStore';
import './terminal-fabric.css';

import { createFabricRouter, type FabricBox as Box } from './fabricRouting';
import { fabricConnections } from './fabricConnections';
export { fabricBridge } from './fabricRouting';

function isDirectOpenCode(target: LiveTerminalTarget): boolean {
  return /(?:^|[\\/])opencode(?:\.exe)?$/i.test(target.command?.trim() ?? '');
}

function FabricPeerOutput({ target }: { target: LiveTerminalTarget }) {
  const output = useTerminalTranscriptStore((state) => state.sessions[target.sessionId]?.text ?? '');
  return (
    <article className="vs-fabric-manage-peer">
      <div className="vs-fabric-manage-peer-title">
        <span>{target.label || `Terminal ${target.ordinal}`}</span>
        <span>{target.provider || target.agentSlug || 'Terminal'}</span>
      </div>
      <p>{target.command || 'Interactive terminal'}</p>
      <pre aria-label={`Recent output from ${target.label || target.sessionId}`}>
        {output.slice(-1800) || 'No output captured yet.'}
      </pre>
    </article>
  );
}

export function TerminalFabricOverlay({
  visible,
  projectId,
  readTargets = readLiveTargetSnapshot,
  paneSelector = '[data-terminal-drop-pane-id]',
}: {
  visible: boolean;
  projectId: string | null;
  readTargets?: () => Promise<LiveTerminalTarget[]>;
  paneSelector?: string;
}) {
  const selecting = useFabricPresentationStore((s) => s.selecting);
  const manageOpen = useFabricPresentationStore((s) => s.managing);
  const peers = useFabricPresentationStore((s) => s.peers);
  const delivery = useFabricPresentationStore((s) => s.delivery);
  const [targets, setTargets] = React.useState<LiveTerminalTarget[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [boxes, setBoxes] = React.useState<Box[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [verified, setVerified] = React.useState<string[]>([]);
  const [relaySource, setRelaySource] = React.useState('');
  const [relayTarget, setRelayTarget] = React.useState('');
  const [relayStatus, setRelayStatus] = React.useState<string | null>(null);
  const [relayBusy, setRelayBusy] = React.useState(false);
  const wasVisible = React.useRef(visible);
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
    // Run can request selection before navigation reveals this mounted route.
    // Cancel only when leaving terminals, not while waiting to enter them.
    if (wasVisible.current && !visible) useFabricPresentationStore.getState().close();
    wasVisible.current = visible;
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
        const live = await readTargets();
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
  }, [visible, selecting, peers, projectId, readTargets]);

  React.useLayoutEffect(() => {
    if (!visible || (!selecting && peers.length === 0)) return;
    const selector = paneSelector;
    let frame = 0;
    const observed = new Set<HTMLElement>();
    const update = () => {
      frame = 0;
      const panes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const pane of observed)
        if (!panes.includes(pane)) {
          observer.unobserve(pane);
          observed.delete(pane);
        }
      const next = panes.flatMap((pane) => {
        if (!observed.has(pane)) {
          observer.observe(pane);
          observed.add(pane);
        }
        const r = pane.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          ? [
              {
                id: pane.dataset.terminalDropPaneId ?? pane.dataset.panelId ?? '',
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
              },
            ]
          : [];
      });
      setBoxes((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // ResizeObserver runs before paint. Commit the measured route in that same
    // frame so a dragged divider cannot leave a stale line over terminal content.
    const observer = new ResizeObserver(() => flushSync(update));
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            (record.type === 'attributes' &&
              record.target instanceof Element &&
              (record.target.matches(selector) || record.target.querySelector(selector))) ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element && (node.matches(selector) || node.querySelector(selector)),
            ),
        )
      )
        schedule();
    });
    update();
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-minimized'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [visible, selecting, peers.length, paneSelector]);

  const routeBridge = React.useMemo(() => createFabricRouter(boxes), [boxes]);

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
    if (submitting.current || selected.length < 2 || selected.length > 10) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const revision = epoch.current;
    try {
      const fresh = await readTargets();
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

  const connected = React.useMemo(
    () =>
      peers.flatMap((peer) => {
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
      }),
    [peers, projectId, targets, boxes, verified],
  );
  const connections = React.useMemo(
    () => fabricConnections(connected, routeBridge),
    [connected, routeBridge],
  );
  const livePeers = React.useMemo(() => peers.flatMap((peer) => {
    const target = targets.find((candidate) =>
      candidate.sessionId === peer.sessionId &&
      candidate.paneId === peer.paneId &&
      candidate.projectId === projectId &&
      candidate.processIdentity.runtimeGeneration === peer.runtimeGeneration &&
      verified.includes(candidate.sessionId));
    return target ? [target] : [];
  }), [peers, targets, projectId, verified]);
  const sendPeerOutput = async () => {
    if (relayBusy || !relaySource || !relayTarget || relaySource === relayTarget) return;
    setRelayBusy(true);
    setRelayStatus(null);
    try {
      const source = livePeers.find((target) => target.sessionId === relaySource);
      const recipient = livePeers.find((target) => target.sessionId === relayTarget);
      if (!source || !recipient) throw Error('Choose two connected live terminals.');
      if (!isDirectOpenCode(source) || !isDirectOpenCode(recipient)) {
        throw Error('Relay requires two directly launched OpenCode agents.');
      }
      const output = useTerminalTranscriptStore.getState().sessions[source.sessionId]?.text.trim();
      if (!output) throw Error('The source terminal has no captured output to relay.');
      const fresh = await readTargets();
      const native = await port.command({
        commandId: 'team.status', correlationId: crypto.randomUUID(), targetIds: [],
      });
      if (native.status !== 'completed' ||
        ![source, recipient].every((target) =>
          native.targetIds.includes(target.sessionId) && fresh.some((candidate) =>
            candidate.sessionId === target.sessionId &&
            candidate.paneId === target.paneId &&
            candidate.projectId === projectId &&
            candidate.processIdentity.processInstanceId === target.processIdentity.processInstanceId &&
            candidate.processIdentity.runtimeGeneration === target.processIdentity.runtimeGeneration))) {
        throw Error('A peer changed or disconnected. Refresh the connection.');
      }
      await invoke('terminal_write', {
        sessionId: recipient.sessionId,
        expectedBinding: recipient.processIdentity,
        agentMessage: true,
        data: `Message from ${source.label || source.sessionId}:\n${output.slice(-1500)}\nPlease reply to this peer message.`,
      });
      recordFabricDelivery(crypto.randomUUID(), source.sessionId, [recipient.sessionId]);
      setRelayStatus(`Sent output from ${source.label || source.sessionId} to ${recipient.label || recipient.sessionId}. Check the recipient terminal for its reply.`);
    } catch (cause) {
      setRelayStatus(cause instanceof Error ? cause.message : 'Relay failed.');
    } finally {
      setRelayBusy(false);
    }
  };
  if (!visible) return null;
  return (
    <>
      {!selecting && livePeers.length > 1 && (
        <>
          <button type="button" className="vs-fabric-manage-trigger"
            aria-label="Manage Terminal Peer Fabric"
            aria-expanded={manageOpen}
            onClick={() => manageOpen
              ? useFabricPresentationStore.getState().closeManage()
              : useFabricPresentationStore.getState().manage()}>
            <MessageSquareText size={15} /> Manage peers <span>{livePeers.length}</span>
          </button>
          {manageOpen && (
            <aside className="vs-fabric-manage" aria-label="Terminal Peer Fabric manager">
              <header>
                <div><strong>Peer Fabric</strong><small>{livePeers.length} native connected terminals</small></div>
                <button type="button" aria-label="Close peer manager" onClick={() => useFabricPresentationStore.getState().closeManage()}><X size={17} /></button>
              </header>
              <div className="vs-fabric-manage-content">
                {livePeers.map((target) => <FabricPeerOutput key={target.sessionId} target={target} />)}
                <section className="vs-fabric-relay" aria-label="Relay peer output">
                  <h3><Send size={14} /> Relay latest output</h3>
                  <label>From<select aria-label="Relay from terminal" value={relaySource} onChange={(event) => setRelaySource(event.target.value)}>
                    <option value="">Choose source</option>
                    {livePeers.map((target) => <option key={target.sessionId} value={target.sessionId}>{target.label || target.sessionId}</option>)}
                  </select></label>
                  <label>To<select aria-label="Relay to terminal" value={relayTarget} onChange={(event) => setRelayTarget(event.target.value)}>
                    <option value="">Choose recipient</option>
                    {livePeers.map((target) => <option key={target.sessionId} value={target.sessionId}>{target.label || target.sessionId}</option>)}
                  </select></label>
                  <button type="button" disabled={relayBusy || !relaySource || !relayTarget || relaySource === relayTarget}
                    onClick={() => void sendPeerOutput()}><RefreshCw size={14} className={relayBusy ? 'animate-spin' : ''} /> Relay to peer</button>
                  {relayStatus && <p role="status">{relayStatus}</p>}
                  <p>Shared files: none recorded. Relay accepts directly launched OpenCode agents only; native writes require a live process binding.</p>
                </section>
              </div>
            </aside>
          )}
        </>
      )}
      {!selecting && connected.length > 1 && (
        <svg className="vs-fabric-bridges" aria-label={`${connected.length} connected terminals`}>
          <defs>
            <linearGradient id="vs-fabric-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="hsl(var(--accent-copper))" />
              <stop offset="0.5" stopColor="hsl(var(--foreground))" />
              <stop offset="1" stopColor="hsl(var(--accent-copper))" />
            </linearGradient>
          </defs>
          {connections.map(({ from, to: box, bridge }) => {
            return (
              <g key={`${from.id}:${box.id}`}>
                <path className="vs-fabric-aura" d={bridge.path} />
                <path className="vs-fabric-track" d={bridge.path} />
                <path className="vs-fabric-line" d={bridge.path} />
                <path className="vs-fabric-flow" d={bridge.path} />
                <circle className="vs-fabric-port-halo" cx={bridge.x1} cy={bridge.y1} r="6" />
                <circle className="vs-fabric-port-halo" cx={bridge.x2} cy={bridge.y2} r="6" />
                <circle className="vs-fabric-port" cx={bridge.x1} cy={bridge.y1} r="2.5" />
                <circle className="vs-fabric-port" cx={bridge.x2} cy={bridge.y2} r="2.5" />
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
              const bridge = routeBridge(from, to);
              if (!bridge) return null;
              return (
                <circle
                  className="vs-fabric-spark"
                  key={`${delivery.id}:${id}`}
                  r="2"
                  onAnimationEnd={() => {
                    if (useFabricPresentationStore.getState().delivery?.id === delivery.id)
                      useFabricPresentationStore.setState({ delivery: null });
                  }}
                >
                  <animateMotion dur="650ms" repeatCount="1" path={bridge.path} />
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
              <p>
                {targets.length < 2
                  ? 'Add at least two terminal panes, then select them here.'
                  : 'Choose 2–10 panes. Selected terminals light up.'}
              </p>
              {error && <p role="alert">{error}</p>}
            </div>
            <span aria-live="polite">{selected.length} / 10</span>
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
            const target = targets.find((t) => t.paneId === box.id);
            if (!target) return null;
            const checked = selected.includes(target.sessionId);
            return (
              <button
                key={box.id}
                type="button"
                className="vs-fabric-pane"
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                aria-label={`Connect ${target.label ?? 'terminal'} ${target.ordinal}`}
                aria-pressed={checked}
                disabled={busy || (!checked && selected.length >= 10)}
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
