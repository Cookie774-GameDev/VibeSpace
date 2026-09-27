import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDownLeft, Hand, MessageCircleMore, RefreshCw, Reply, Send, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RelayFlowerBackdrop } from './RelayFlowerBackdrop';
import './RelayGroupChat.css';

export interface RelayRoomParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  status: 'online' | 'busy' | 'offline' | 'unknown';
  harness?: string;
  model?: string;
  persona?: string;
  task?: string;
  files?: readonly string[];
  latestPrompt?: string;
}

export interface RelayRoomMessage {
  id: string;
  participantId: string;
  text: string;
  at: number;
  kind: 'message' | 'report';
  parentId?: string;
  replyCount?: number;
}

export interface RelayRoomView {
  connection: 'connected' | 'connecting' | 'offline';
  scope: 'Project' | 'Entire app';
  participants: readonly RelayRoomParticipant[];
  messages: readonly RelayRoomMessage[];
}

export interface RelayGroupChatProps {
  open: boolean;
  presentation?: 'drawer' | 'inspector';
  room: RelayRoomView;
  humanAuthorized: boolean;
  onClose: () => void;
  onSend: (text: string, parentMessageId?: string) => Promise<void> | void;
  onStopAll?: () => Promise<void> | void;
  onRefresh?: () => Promise<void> | void;
}

function avatarVariant(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 4;
}

function AgentAvatar({ participant, size = 34 }: { participant: RelayRoomParticipant; size?: number }) {
  const variant = participant.kind === 'human' ? 4 : avatarVariant(participant.id);
  return <span className={`relay-avatar relay-avatar--${variant}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none" focusable="false">
      {variant === 0 && <><path d="M8 17 12 5l10 8h4L36 5l4 12v11c0 9-7 15-16 15S8 37 8 28V17Z" fill="#EF9C65" stroke="#704337" strokeWidth="2" /><path d="m10 22 7 3 7 1 7-1 7-3c-1 11-6 18-14 18S11 33 10 22Z" fill="#FFF3D9" /><path d="M18 26v1m12-1v1" stroke="#533D39" strokeWidth="3.5" strokeLinecap="round" /><path d="m21 32 3 2 3-2" stroke="#533D39" strokeWidth="2" strokeLinecap="round" /></>}
      {variant === 1 && <><path d="M9 20 12 8l9 5 3-3 3 3 9-5 3 12v9c0 9-6 14-15 14S9 38 9 29v-9Z" fill="#A389CA" stroke="#594C79" strokeWidth="2" /><ellipse cx="17" cy="25" rx="7" ry="8" fill="#F6ECFF" /><ellipse cx="31" cy="25" rx="7" ry="8" fill="#F6ECFF" /><circle cx="18" cy="26" r="2.2" fill="#51445E" /><circle cx="30" cy="26" r="2.2" fill="#51445E" /><path d="m24 29-3 3 3 3 3-3-3-3Z" fill="#E6AA62" /></>}
      {variant === 2 && <><path d="M17 10 13 5M31 10l4-5" stroke="#456780" strokeWidth="3" strokeLinecap="round" /><rect x="8" y="10" width="32" height="32" rx="13" fill="#75B9CA" stroke="#456780" strokeWidth="2" /><rect x="12" y="18" width="24" height="15" rx="7" fill="#ECFCFB" /><circle cx="19" cy="25" r="2.2" fill="#344D62" /><circle cx="29" cy="25" r="2.2" fill="#344D62" /><path d="M20 34c2 2 6 2 8 0" stroke="#456780" strokeWidth="2" strokeLinecap="round" /></>}
      {variant === 3 && <><path d="M10 19 14 6l10 7 10-7 4 13v10c0 8-6 14-14 14S10 37 10 29V19Z" fill="#E9B1AE" stroke="#86585A" strokeWidth="2" /><path d="M16 26h4m8 0h4" stroke="#5D4748" strokeWidth="2.5" strokeLinecap="round" /><path d="m22 31 2 2 2-2M16 33l-5 1m21-1 5 1" stroke="#5D4748" strokeWidth="2" strokeLinecap="round" /></>}
      {variant === 4 && <><circle cx="24" cy="24" r="20" fill="#EAC58C" stroke="#8B6649" strokeWidth="2" /><path d="m15 13 3 4 6-7 6 7 3-4" fill="#FFEFCA" stroke="#8B6649" strokeWidth="1.7" strokeLinejoin="round" /><path d="M17 25v1m14-1v1" stroke="#6E5040" strokeWidth="3" strokeLinecap="round" /><path d="M19 32c3 3 7 3 10 0" stroke="#6E5040" strokeWidth="2" strokeLinecap="round" /></>}
    </svg>
  </span>;
}

function ProfileField({ label, value }: { label: string; value?: string }) {
  return <div className="relay-profile-field"><dt>{label}</dt><dd>{value?.trim() || 'Not shared'}</dd></div>;
}

export function RelayGroupChat({ open, presentation = 'drawer', room, humanAuthorized, onClose, onSend, onStopAll, onRefresh }: RelayGroupChatProps) {
  const [draft, setDraft] = React.useState('');
  const [replyToId, setReplyToId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [stopConfirmation, setStopConfirmation] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  const timelineRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();
  const participants = React.useMemo(() => new Map(room.participants.map((participant) => [participant.id, participant])), [room.participants]);
  const selected = selectedId ? participants.get(selectedId) : undefined;
  const replyTarget = replyToId ? room.messages.find((message) => message.id === replyToId) : undefined;
  const connected = room.connection === 'connected';

  React.useEffect(() => {
    if (!open) { setStopConfirmation(false); setSelectedId(null); setReplyToId(null); return; }
    const timeline = timelineRef.current;
    if (!timeline) return;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }, [open, room.messages.length]);

  React.useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedId) setSelectedId(null);
      else onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose, selectedId]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connected || !humanAuthorized || busyRef.current) return;
    if (replyToId && !replyTarget) { setError('That reply target is no longer visible. Choose another message.'); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try { if (replyTarget) await onSend(text, replyTarget.id); else await onSend(text); setDraft(''); setReplyToId(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Message was not delivered.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const stopAgents = async () => {
    if (!onStopAll || !connected || !humanAuthorized || busyRef.current) return;
    if (!stopConfirmation) { setStopConfirmation(true); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try { await onStopAll(); setStopConfirmation(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Agents could not be stopped.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return <div className={`relay-group-backdrop ${presentation === 'inspector' ? 'relay-group-backdrop--inspector' : ''}`} onMouseDown={(event) => { if (presentation === 'drawer' && event.target === event.currentTarget) onClose(); }}>
    <motion.section className={`relay-group-panel ${presentation === 'inspector' ? 'relay-group-panel--inspector' : ''}`} role={presentation === 'inspector' ? 'region' : 'dialog'} aria-modal={presentation === 'drawer' ? true : undefined} aria-label="Agent Relay group chat"
      initial={reduceMotion ? false : { x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 340, damping: 34 }}>
      <header className="relay-group-header">
        <span className="relay-group-emblem" aria-hidden="true"><MessageCircleMore size={21} /></span>
        <div className="relay-group-heading"><span className="relay-group-eyebrow">LIVE ROOM</span><h2>Agent Relay</h2><p><span className={`relay-group-connection relay-group-connection--${room.connection}`} /> {room.connection === 'connected' ? 'Connected' : room.connection === 'connecting' ? 'Connecting' : 'Offline'} <span aria-hidden="true">·</span> {room.scope}</p></div>
        {onRefresh && <Button type="button" size="icon-sm" variant="ghost" aria-label="Refresh Agent Relay" title="Refresh room" onClick={() => void onRefresh()}><RefreshCw size={16} /></Button>}
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close Agent Relay" onClick={onClose}><X size={18} /></Button>
      </header>
      <div className="relay-group-members" aria-label="Room participants">
        {room.participants.map((participant) => <button type="button" className={`relay-group-member ${selectedId === participant.id ? 'relay-group-member--selected' : ''}`} key={participant.id} onClick={() => setSelectedId(participant.id)} aria-label={`View ${participant.name} profile`}>
          <AgentAvatar participant={participant} /><span className="relay-group-member-copy"><span className="relay-group-member-name">{participant.name}</span><span className="relay-group-member-caption">{participant.kind === 'human' ? 'Room owner' : participant.status}</span></span>
          {participant.kind === 'human' && humanAuthorized && <ShieldCheck size={13} aria-label="Owner" />}<span className={`relay-group-presence relay-group-presence--${participant.status}`} aria-label={participant.status} />
        </button>)}
        {!room.participants.length && <span className="relay-group-muted">No participants connected.</span>}
      </div>
      <div className="relay-group-content">
        {presentation === 'inspector' && <RelayFlowerBackdrop seed={room.scope} scrollRef={timelineRef} />}
        <div className="relay-group-timeline" ref={timelineRef} aria-label="Group messages" aria-live="polite">
          {!connected && <p className="relay-group-empty">Relay is {room.connection === 'connecting' ? 'connecting' : 'offline'}</p>}
          {connected && !room.messages.length && <p className="relay-group-empty">No messages yet. Agents will appear here when they join.</p>}
          {room.messages.map((message) => {
            const participant = participants.get(message.participantId);
            const parent = message.parentId ? room.messages.find((item) => item.id === message.parentId) : undefined;
            const parentAuthor = parent ? participants.get(parent.participantId)?.name ?? 'Agent' : 'Earlier message';
            return <motion.article data-relay-message-id={message.id} className={`relay-group-message ${message.parentId ? 'relay-group-message--reply' : ''}`} key={message.id} initial={reduceMotion ? false : { y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: .22 }}>
              {message.parentId && <span className="relay-group-reply-mark" aria-label="Thread reply"><ArrowDownLeft size={14} /></span>}
              <AgentAvatar participant={participant ?? { id: message.participantId, name: 'Unknown participant', kind: 'agent', status: 'unknown' }} size={32} />
              <div className="relay-group-message-body"><div className="relay-group-byline"><button type="button" onClick={() => participant && setSelectedId(participant.id)} disabled={!participant}>{participant?.name ?? 'Unknown participant'}</button>
                {participant?.kind === 'human' && humanAuthorized && <span className="relay-group-owner">Owner</span>}{message.kind === 'report' && <span className="relay-group-report">Report</span>}
                {Number.isFinite(message.at) && <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}</div>
                {message.parentId && <div className="relay-group-parent-context"><Reply size={12} aria-hidden="true" /><span>To {parentAuthor}{parent ? `: ${parent.text.slice(0, 80)}` : ''}</span></div>}
                <p>{message.text}</p><div className="relay-group-message-actions">{!!message.replyCount && !message.parentId && <span className="relay-group-reply-count">{message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}</span>}
                  {connected && humanAuthorized && <button type="button" aria-label={`Reply to ${participant?.name ?? 'message'}`} onClick={() => { setReplyToId(message.id); composerRef.current?.focus(); }}><Reply size={12} aria-hidden="true" /> Reply</button>}</div></div>
            </motion.article>;
          })}
        </div>
        <AnimatePresence>{selected && <motion.aside className="relay-group-profile" aria-label={`${selected.name} profile`} initial={reduceMotion ? false : { x: 18, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={reduceMotion ? undefined : { x: 18, opacity: 0 }} transition={{ duration: .18 }}>
          <div className="relay-profile-top"><AgentAvatar participant={selected} size={54} /><Button type="button" size="icon-sm" variant="ghost" aria-label="Close agent profile" onClick={() => setSelectedId(null)}><X size={16} /></Button></div>
          <h3>{selected.name}</h3><p className="relay-profile-status">{selected.kind === 'human' ? 'Room owner' : selected.status} · {selected.kind === 'human' ? 'Human' : 'Agent'}</p>
          <dl><ProfileField label="Harness" value={selected.harness} /><ProfileField label="Model" value={selected.model} /><ProfileField label="Working on" value={selected.task ?? selected.persona} /><ProfileField label="Files" value={selected.files?.join(', ')} /><ProfileField label="Latest prompt" value={selected.latestPrompt} /></dl>
          <p className="relay-profile-note">Details appear when an agent shares them with this room.</p>
        </motion.aside>}</AnimatePresence>
      </div>
      {error && <p role="alert" className="relay-group-error">{error}</p>}
      <footer className="relay-group-footer"><form onSubmit={(event) => void submit(event)}>
        {replyToId && <div className="relay-group-reply-preview"><Reply size={14} aria-hidden="true" /><span>Replying to {replyTarget ? participants.get(replyTarget.participantId)?.name ?? 'Agent' : 'earlier message'}{replyTarget ? ` · ${replyTarget.text.slice(0, 78)}` : ''}</span><button type="button" aria-label="Cancel reply" onClick={() => setReplyToId(null)}><X size={14} /></button></div>}
        <textarea ref={composerRef} aria-label="Message Agent Relay" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(event); } }} placeholder={connected ? replyToId ? 'Reply in this thread…' : 'Message the room as you…' : 'Connect Relay to message agents'} disabled={!connected || !humanAuthorized || busy} rows={2} />
        <div className="relay-group-actions">{onStopAll && humanAuthorized && connected && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void stopAgents()} aria-label={stopConfirmation ? 'Confirm stop agents' : 'Stop agents'}><Hand size={14} /> {stopConfirmation ? 'Confirm stop' : 'Stop agents'}</Button>}
          <span className="relay-group-muted">{humanAuthorized ? <><ShieldCheck size={12} /> You speak as the room owner</> : 'Owner access unavailable'}</span>
          <Button type="submit" variant="accent" size="sm" disabled={!draft.trim() || !connected || !humanAuthorized || busy} aria-label="Send to group"><Send size={14} /> Send</Button></div>
      </form></footer>
    </motion.section>
  </div>;
}
