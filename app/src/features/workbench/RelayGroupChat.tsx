import * as React from 'react';
import { Hand, MessageCircleMore, Send, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import './RelayGroupChat.css';

export interface RelayRoomParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  status: 'online' | 'busy' | 'offline' | 'unknown';
  harness?: string;
}

export interface RelayRoomMessage {
  id: string;
  participantId: string;
  text: string;
  at: number;
  kind: 'message' | 'report';
}

export interface RelayRoomView {
  connection: 'connected' | 'connecting' | 'offline';
  scope: 'Project' | 'Entire app';
  participants: readonly RelayRoomParticipant[];
  messages: readonly RelayRoomMessage[];
}

export interface RelayGroupChatProps {
  open: boolean;
  room: RelayRoomView;
  humanAuthorized: boolean;
  onClose: () => void;
  onSend: (text: string) => Promise<void> | void;
  onStopAll: () => Promise<void> | void;
}

const AGENT_ICONS = ['🦊', '🌙', '🦉', '🐙', '🐝', '🪄'] as const;

function avatarFor(participant: RelayRoomParticipant): string {
  if (participant.kind === 'human') return '🧡';
  let hash = 0;
  for (const char of participant.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return AGENT_ICONS[(hash >>> 0) % AGENT_ICONS.length]!;
}

export function RelayGroupChat({ open, room, humanAuthorized, onClose, onSend, onStopAll }: RelayGroupChatProps) {
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [stopConfirmation, setStopConfirmation] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  const timelineRef = React.useRef<HTMLDivElement>(null);
  const participants = React.useMemo(
    () => new Map(room.participants.map((participant) => [participant.id, participant])),
    [room.participants],
  );
  const connected = room.connection === 'connected';

  React.useEffect(() => {
    if (!open) {
      setStopConfirmation(false);
      return;
    }
    const timeline = timelineRef.current;
    if (!timeline) return;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }, [open, room.messages.length]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connected || !humanAuthorized || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSend(text);
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message was not delivered.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const stopAgents = async () => {
    if (!connected || !humanAuthorized || busyRef.current) return;
    if (!stopConfirmation) {
      setStopConfirmation(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onStopAll();
      setStopConfirmation(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agents could not be stopped.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="relay-group-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="relay-group-panel" role="dialog" aria-modal="true" aria-label="Agent Relay group chat">
        <header className="relay-group-header">
          <span className="relay-group-emblem" aria-hidden="true"><MessageCircleMore size={21} /></span>
          <div className="relay-group-heading">
            <h2>Agent Relay</h2>
            <p>One room · {room.scope} · {room.connection === 'connected' ? 'Connected' : room.connection === 'connecting' ? 'Connecting' : 'Offline'}</p>
          </div>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close Agent Relay" onClick={onClose}><X size={18} /></Button>
        </header>

        <div className="relay-group-members" aria-label="Room participants">
          {room.participants.map((participant) => (
            <div className="relay-group-member" key={participant.id} title={`${participant.name} · ${participant.status}`}>
              <span className="relay-group-avatar" aria-hidden="true">{avatarFor(participant)}</span>
              <span className="relay-group-member-name">{participant.name}</span>
              {participant.kind === 'human' && humanAuthorized && <ShieldCheck size={12} aria-label="Owner" />}
              <span className={`relay-group-presence relay-group-presence--${participant.status}`} aria-label={participant.status} />
            </div>
          ))}
          {!room.participants.length && <span className="relay-group-muted">No participants connected.</span>}
        </div>

        <div className="relay-group-timeline" ref={timelineRef} aria-label="Group messages" aria-live="polite">
          {!connected && <p className="relay-group-empty">Relay is {room.connection === 'connecting' ? 'connecting' : 'offline'}</p>}
          {connected && !room.messages.length && <p className="relay-group-empty">No messages yet. Agents will appear here when they join.</p>}
          {room.messages.map((message) => {
            const participant = participants.get(message.participantId);
            return (
              <article className="relay-group-message" key={message.id}>
                <span className="relay-group-avatar" aria-hidden="true">{participant ? avatarFor(participant) : '✦'}</span>
                <div className="relay-group-message-body">
                  <div className="relay-group-byline">
                    <strong>{participant?.name ?? 'Unknown participant'}</strong>
                    {participant?.kind === 'human' && humanAuthorized && <span className="relay-group-owner">Owner</span>}
                    {message.kind === 'report' && <span className="relay-group-report">Report</span>}
                    {Number.isFinite(message.at) && <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}
                  </div>
                  <p>{message.text}</p>
                </div>
              </article>
            );
          })}
        </div>

        {error && <p role="alert" className="relay-group-error">{error}</p>}
        <footer className="relay-group-footer">
          <form onSubmit={(event) => void submit(event)}>
            <textarea aria-label="Message Agent Relay" value={draft} onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(event); }
              }} placeholder={connected ? 'Message every agent in this room…' : 'Connect Relay to message agents'}
              disabled={!connected || !humanAuthorized || busy} rows={2} />
            <div className="relay-group-actions">
              {humanAuthorized && connected && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void stopAgents()} aria-label={stopConfirmation ? 'Confirm stop agents' : 'Stop agents'}>
                <Hand size={14} /> {stopConfirmation ? 'Confirm stop' : 'Stop agents'}
              </Button>}
              <span className="relay-group-muted">{humanAuthorized ? 'You speak as the room owner.' : 'Owner access unavailable.'}</span>
              <Button type="submit" variant="accent" size="sm" disabled={!draft.trim() || !connected || !humanAuthorized || busy} aria-label="Send to group"><Send size={14} /> Send</Button>
            </div>
          </form>
        </footer>
      </section>
    </div>
  );
}
