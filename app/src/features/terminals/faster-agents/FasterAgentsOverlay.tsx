import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { Check, ChevronDown, Plus, Trash2, Volume2, VolumeX, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { enqueueTerminalCommand } from '../terminalCommandQueue';
import type { TerminalRef } from '../terminalRefs';
import {
  FASTER_AGENTS_MAX_PHRASES,
  FASTER_AGENTS_MAX_TARGETS,
  fasterAgentsRefKey,
  pickFasterAgentsPhrase,
  useFasterAgentsStore,
} from './fasterAgentsStore';
import { WhipCanvas } from './WhipCanvas';
import { playOpenWhipCrack, preloadOpenWhipCracks } from './fasterAgentsAudio';

const SELECT_VOICE_URL = '/audio/faster-agents/select-your-snail.wav';

export interface FasterAgentsTerminalOption {
  ref: TerminalRef;
  label: string;
  detail: string;
}

async function playSelectVoice(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const audio = new Audio(SELECT_VOICE_URL);
  audio.volume = 0.9;
  signal.addEventListener('abort', () => audio.pause(), { once: true });
  await audio.play();
}

export function FasterAgentsOverlay({
  terminals,
  surface = 'terminal',
  deliver,
}: {
  terminals: FasterAgentsTerminalOption[];
  surface?: 'terminal' | 'workbench';
  deliver?: (command: string, refs: readonly TerminalRef[]) => number;
}) {
  const route = useUIStore((state) => state.route);
  const requested = useFasterAgentsStore((state) => state.open);
  // The terminals page can stay mounted behind Workbench. Only one picker owns input.
  const open =
    requested && (surface === 'workbench' ? route === 'workbench' : route !== 'workbench');
  const phase = useFasterAgentsStore((state) => state.phase);
  const selectedRefs = useFasterAgentsStore((state) => state.selectedRefs);
  const phrases = useFasterAgentsStore((state) => state.phrases);
  const soundEnabled = useFasterAgentsStore((state) => state.soundEnabled);
  const selectedKeys = React.useMemo(
    () => new Set(selectedRefs.map(fasterAgentsRefKey)),
    [selectedRefs],
  );
  const terminalByPaneId = React.useMemo(
    () => new Map(terminals.map((terminal) => [terminal.ref.paneId, terminal])),
    [terminals],
  );

  React.useEffect(() => {
    if (!open || phase !== 'select') return;
    const controller = new AbortController();
    preloadOpenWhipCracks();
    void playSelectVoice(controller.signal).catch(() => {
      if (!controller.signal.aborted) toast.warning('Voice unavailable', 'Select your Snail');
    });
    return () => controller.abort();
  }, [open, phase]);

  React.useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.fasterAgentsSelecting = phase === 'select' ? 'true' : 'false';
    document.documentElement.dataset.fasterAgentsWhipping = phase === 'whip' ? 'true' : 'false';
    const panes = document.querySelectorAll<HTMLElement>('[data-terminal-drop-pane-id]');
    for (const pane of panes) {
      const paneId = pane.dataset.terminalDropPaneId ?? '';
      const selected = selectedKeys.has(paneId);
      pane.dataset.fasterAgentsSelected = selected ? 'true' : 'false';
      pane.setAttribute(
        'aria-description',
        selected ? 'Selected for Faster Agents' : 'Not selected for Faster Agents',
      );
    }
    return () => {
      delete document.documentElement.dataset.fasterAgentsSelecting;
      delete document.documentElement.dataset.fasterAgentsWhipping;
      for (const pane of panes) {
        delete pane.dataset.fasterAgentsSelected;
        pane.removeAttribute('aria-description');
      }
    };
  }, [open, phase, selectedKeys]);

  React.useEffect(() => {
    if (!open || phase !== 'select') return;
    const selectPane = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== undefined) return;
      const target = event.target instanceof Element ? event.target : null;
      const pane = target?.closest<HTMLElement>('[data-terminal-drop-pane-id]');
      if (!pane) return;
      const terminal = terminalByPaneId.get(pane.dataset.terminalDropPaneId ?? '');
      if (!terminal) return;
      event.preventDefault();
      event.stopPropagation();
      const wasSelected = selectedKeys.has(fasterAgentsRefKey(terminal.ref));
      const changed = useFasterAgentsStore.getState().toggleRef(terminal.ref);
      if (!changed && !wasSelected) {
        toast.warning('Selection limit reached', `Choose at most ${FASTER_AGENTS_MAX_TARGETS}.`);
      }
    };
    document.addEventListener('pointerdown', selectPane, true);
    return () => document.removeEventListener('pointerdown', selectPane, true);
  }, [open, phase, selectedKeys, terminalByPaneId]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        useFasterAgentsStore.getState().close();
      } else if (
        event.key === 'Enter' &&
        phase === 'select' &&
        useFasterAgentsStore.getState().selectedRefs.length > 0
      ) {
        event.preventDefault();
        useFasterAgentsStore.getState().continueToWhip();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, phase]);

  if (!open) return null;

  const crack = () => {
    if (selectedRefs.length === 0) return;
    const phrase = pickFasterAgentsPhrase(phrases);
    const count = deliver ? deliver(phrase, selectedRefs) : selectedRefs.length;
    if (!deliver) enqueueTerminalCommand({ command: phrase, target: 'refs', refs: selectedRefs });
    if (!count) {
      toast.warning('No live targets', 'Select your Workbench terminals again.');
      return;
    }
    if (soundEnabled) {
      void playOpenWhipCrack().then((played) => {
        if (!played) toast.warning('Whip sound unavailable', 'The phrase was still delivered.');
      });
    }
    toast.success(
      'Whip delivered',
      `${count} selected terminal${count === 1 ? '' : 's'} queued one phrase.`,
    );
  };

  const close = () => useFasterAgentsStore.getState().close();

  return (
    <>
      <style>{`
        html[data-faster-agents-selecting="true"] [data-terminal-drop="pane"], html[data-faster-agents-whipping="true"] [data-terminal-drop="pane"] { opacity:.2; filter:brightness(.38) saturate(.45); transition:opacity 140ms ease,filter 140ms ease,box-shadow 140ms ease; }
        html[data-faster-agents-selecting="true"] [data-terminal-drop="pane"] { cursor:pointer; }
        html[data-faster-agents-selecting="true"] [data-terminal-drop="pane"][data-faster-agents-selected="true"], html[data-faster-agents-whipping="true"] [data-terminal-drop="pane"][data-faster-agents-selected="true"] { opacity:1; filter:brightness(1.12) saturate(1.08); box-shadow:0 0 0 2px #d39a45,0 0 34px rgba(211,154,69,.55); position:relative; z-index:90; }
        @media (prefers-reduced-motion: reduce) { html [data-terminal-drop="pane"] { transition:none !important; } }
      `}</style>
      <div
        aria-hidden="true"
        data-testid="faster-agents-dimmer"
        className={`pointer-events-none fixed inset-0 z-[80] ${phase === 'select' ? 'bg-black/55' : 'bg-black/25'}`}
      />

      {phase === 'select' ? (
        <section
          aria-label="Select terminals for Faster Agents"
          className="pointer-events-auto fixed left-1/2 top-4 z-[120] flex w-[min(46rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-accent-copper/60 bg-background/95 px-4 py-3 shadow-2xl backdrop-blur"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent-copper text-accent-copper">
            <span aria-hidden>🐌</span>
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-foreground">Select your Snail</h2>
            <p className="truncate text-xs text-muted-foreground">
              Click 1–{FASTER_AGENTS_MAX_TARGETS} real terminal panes. Selected panes light up.
            </p>
          </div>
          <span aria-live="polite" className="shrink-0 text-sm font-semibold text-accent-copper">
            {selectedRefs.length} / {FASTER_AGENTS_MAX_TARGETS}
          </span>
          <Button
            type="button"
            disabled={selectedRefs.length === 0}
            onClick={() => useFasterAgentsStore.getState().continueToWhip()}
          >
            <Check className="h-4 w-4" /> Done selecting
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close Faster Agents"
            onClick={close}
          >
            <X className="h-4 w-4" />
          </Button>
        </section>
      ) : (
        <>
          <WhipCanvas onCrack={crack} onDismiss={close} />
          <section
            aria-label="Faster Agents whip controls"
            className="fixed left-1/2 top-4 z-[120] w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-accent-copper/60 bg-background/92 px-3 py-2 shadow-2xl backdrop-blur"
          >
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 shrink-0 text-accent-copper" />
              <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                Whip enabled for {selectedRefs.length} selected terminal
                {selectedRefs.length === 1 ? '' : 's'} · move fast to crack · click or Esc to finish
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={soundEnabled ? 'Mute whip sounds' : 'Enable whip sounds'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => useFasterAgentsStore.getState().setSoundEnabled(!soundEnabled)}
              >
                {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close Faster Agents"
                onClick={close}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <details className="mt-1" onPointerDown={(event) => event.stopPropagation()}>
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground">
                <ChevronDown className="h-3.5 w-3.5" /> Edit phrases
              </summary>
              <div className="mt-2 grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
                {phrases.map((phrase, index) => (
                  <div key={index} className="rounded-lg border border-border bg-paper p-2">
                    <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Phrase {index + 1}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={phrases.length <= 1}
                        aria-label={`Remove phrase ${index + 1}`}
                        onClick={() => useFasterAgentsStore.getState().removePhrase(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Textarea
                      value={phrase}
                      maxLength={500}
                      rows={2}
                      aria-label={`Phrase ${index + 1}`}
                      onChange={(event) =>
                        useFasterAgentsStore.getState().setPhrase(index, event.target.value)
                      }
                    />
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={phrases.length >= FASTER_AGENTS_MAX_PHRASES}
                onClick={() => useFasterAgentsStore.getState().addPhrase()}
              >
                <Plus className="h-4 w-4" /> Add phrase
              </Button>
            </details>
          </section>
        </>
      )}
    </>
  );
}
