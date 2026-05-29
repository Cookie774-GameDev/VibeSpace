/**
 * Call feature store — call state machine + LiveKit room state.
 *
 * Owns:
 *  - call status (idle | connecting | ringing | in-call | ending | error)
 *  - last error message
 *  - active call_id (correlates with cloud audit + bridge tool_calls)
 *  - room name (LiveKit room the user joined)
 *  - mute state
 *  - persona used for this call (defaults to user's preferred persona)
 *  - live transcript (cumulative; cleared on hangup)
 *
 * Distinct from `useVoiceStore` which is for the on-device Web Speech voice
 * modal. The phone-jarvis call uses the cloud Pipecat pipeline; transcripts
 * stream in over LiveKit data channels (Pipecat publishes them as text events).
 */

import { create } from 'zustand';
import type { PersonaPreset } from '@/types/common';

export type CallStatus =
  | 'idle'
  | 'connecting'   // Requested LiveKit token from cloud
  | 'ringing'      // Joined room, waiting for AI agent to join
  | 'in-call'      // AI agent in room, audio flowing
  | 'ending'       // Hangup requested, tearing down
  | 'error';

export interface CallTranscriptEntry {
  /** 'user' or 'agent'. */
  role: 'user' | 'agent';
  /** The transcribed / generated text. */
  text: string;
  /** ms since epoch. */
  ts: number;
}

interface CallStore {
  status: CallStatus;
  errorMessage: string | null;
  callId: string | null;
  roomName: string | null;
  persona: PersonaPreset;
  muted: boolean;
  transcript: CallTranscriptEntry[];
  /** Set true when AI says "okay, going to write..." and is awaiting yes/no. */
  awaitingConfirm: { tool: string; summary: string } | null;
  /** Set true after user says the unlock phrase mid-call. Resets on hangup. */
  unlockActive: boolean;

  // Actions
  setStatus: (s: CallStatus, errorMessage?: string) => void;
  setCall: (callId: string, roomName: string) => void;
  setPersona: (p: PersonaPreset) => void;
  setMuted: (muted: boolean) => void;
  pushTranscript: (entry: CallTranscriptEntry) => void;
  clearTranscript: () => void;
  setAwaitingConfirm: (a: { tool: string; summary: string } | null) => void;
  setUnlockActive: (active: boolean) => void;
  resetCall: () => void;
}

const defaults: Pick<
  CallStore,
  'status' | 'errorMessage' | 'callId' | 'roomName' | 'muted' | 'transcript' | 'awaitingConfirm' | 'unlockActive'
> = {
  status: 'idle',
  errorMessage: null,
  callId: null,
  roomName: null,
  muted: false,
  transcript: [],
  awaitingConfirm: null,
  unlockActive: false,
};

export const useCallStore = create<CallStore>((set) => ({
  ...defaults,
  persona: 'jarvis',

  setStatus: (s, errorMessage) =>
    set({
      status: s,
      errorMessage: s === 'error' ? errorMessage ?? 'Call error' : null,
    }),

  setCall: (callId, roomName) => set({ callId, roomName }),

  setPersona: (p) => set({ persona: p }),

  setMuted: (muted) => set({ muted }),

  pushTranscript: (entry) =>
    set((s) => ({
      transcript: [...s.transcript, entry],
    })),

  clearTranscript: () => set({ transcript: [] }),

  setAwaitingConfirm: (a) => set({ awaitingConfirm: a }),

  setUnlockActive: (active) => set({ unlockActive: active }),

  resetCall: () => set({ ...defaults }),
}));
