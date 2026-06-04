/**
 * CallService — LiveKit client wrapper for Path C in-app voice calls.
 *
 * Flow:
 *   1. user clicks "Call Sage" -> CallService.start(persona)
 *   2. fetch Supabase JWT
 *   3. POST {cloudUrl}/livekit/token with Authorization: Bearer <jwt>
 *      cloud responds: { url, token, room, call_id }
 *   4. Connect to LiveKit room with that token
 *   5. Publish microphone (request permission first)
 *   6. Subscribe to remote audio (the AI agent)
 *   7. Listen for data messages (Pipecat sends transcripts via DataChannel)
 *   8. On disconnect or stop(), tear down
 *
 * Errors at any step bubble through the call store as status='error'.
 *
 * Default cloud URL comes from `import.meta.env.VITE_PHONE_JARVIS_CLOUD_URL`.
 * If unset, the call button is disabled and Settings shows a setup card.
 */

import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type LocalAudioTrack,
  type DataPacket_Kind,
} from 'livekit-client';
import { getSupabaseClient } from '@/lib/supabase/client';
import type { PersonaPreset } from '@/types/common';
import { useCallStore } from './store';

interface TokenResponse {
  url: string;
  token: string;
  room: string;
  call_id: string;
}

export interface CallServiceOptions {
  cloudUrl?: string;
}

export class CallService {
  private room: Room | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private remoteAudioEl: HTMLAudioElement | null = null;
  private cloudUrl: string;

  constructor(opts?: CallServiceOptions) {
    this.cloudUrl = opts?.cloudUrl ?? this.resolveCloudUrl();
  }

  private resolveCloudUrl(): string {
    const env = (import.meta.env as Record<string, string | undefined>)
      .VITE_PHONE_JARVIS_CLOUD_URL;
    return (env ?? '').replace(/\/$/, '');
  }

  /** True if we have a cloud URL configured. */
  isConfigured(): boolean {
    return Boolean(this.cloudUrl);
  }

  getCloudUrl(): string {
    return this.cloudUrl;
  }

  /**
   * Start a Path C call. Sets call store status as it progresses.
   * Returns when the room is joined; the AI agent will join shortly after
   * and status flips to 'in-call' on first remote audio track.
   */
  async start(persona: PersonaPreset = 'jarvis'): Promise<void> {
    const store = useCallStore.getState();

    if (!this.cloudUrl) {
      store.setStatus('error', 'phone-jarvis cloud URL not configured');
      return;
    }

    store.setPersona(persona);
    store.setStatus('connecting');
    store.clearTranscript();

    // 1. Auth
    const supa = getSupabaseClient();
    if (!supa) {
      store.setStatus('error', 'Jarvis Cloud is not configured in this build');
      return;
    }
    let jwt: string | undefined;
    try {
      const { data } = await supa.auth.getSession();
      jwt = data.session?.access_token;
    } catch (e) {
      store.setStatus('error', `auth: ${(e as Error).message}`);
      return;
    }
    if (!jwt) {
      store.setStatus('error', 'Sign in to make a call');
      return;
    }

    // 2. Fetch room token from cloud
    let resp: TokenResponse;
    try {
      const r = await fetch(`${this.cloudUrl}/livekit/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ persona }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`token endpoint ${r.status}: ${text || r.statusText}`);
      }
      resp = (await r.json()) as TokenResponse;
    } catch (e) {
      store.setStatus('error', `token: ${(e as Error).message}`);
      return;
    }

    store.setCall(resp.call_id, resp.room);

    // 3. Connect to LiveKit room
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    this.room = room;

    this.wireRoomEvents(room);

    try {
      await room.connect(resp.url, resp.token);
    } catch (e) {
      store.setStatus('error', `connect: ${(e as Error).message}`);
      this.room = null;
      return;
    }

    // 4. Request mic + publish
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      // Find the published audio track for mute control
      const pub = Array.from(room.localParticipant.audioTrackPublications.values())[0];
      this.localTrack = (pub?.audioTrack ?? null) as LocalAudioTrack | null;
    } catch (e) {
      store.setStatus('error', `microphone: ${(e as Error).message}`);
      await this.stop();
      return;
    }

    store.setStatus('ringing');
  }

  /** Hang up. Disconnects from the room; cloud-side agent task ends naturally. */
  async stop(): Promise<void> {
    const store = useCallStore.getState();
    store.setStatus('ending');

    try {
      if (this.localTrack) {
        try {
          this.localTrack.stop();
        } catch {
          // ignore
        }
        this.localTrack = null;
      }
      if (this.room) {
        await this.room.disconnect();
        this.room = null;
      }
      this.detachRemoteAudio();
    } catch (e) {
      console.error('[CallService] stop:', e);
    } finally {
      store.resetCall();
    }
  }

  /** Mute / unmute the microphone without ending the call. */
  setMuted(muted: boolean): void {
    if (!this.room) return;
    void this.room.localParticipant.setMicrophoneEnabled(!muted);
    useCallStore.getState().setMuted(muted);
  }

  /** Send a data message (e.g. spoken-yes confirmation, unlock phrase). */
  sendData(message: Record<string, unknown>): void {
    if (!this.room || this.room.state !== ConnectionState.Connected) return;
    try {
      const payload = new TextEncoder().encode(JSON.stringify(message));
      // Reliable kind = 0 (default); lossy = 1
      void this.room.localParticipant.publishData(payload, { reliable: true } as { reliable: boolean; kind?: DataPacket_Kind });
    } catch (e) {
      console.error('[CallService] sendData:', e);
    }
  }

  // ----- internal -----

  private wireRoomEvents(room: Room): void {
    const store = useCallStore.getState();

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        this.attachRemoteAudio(track as RemoteAudioTrack, participant);
        if (useCallStore.getState().status === 'ringing') {
          useCallStore.getState().setStatus('in-call');
        }
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        this.detachRemoteAudio();
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      // If the AI agent left, end the call
      if (p.identity.startsWith('sage_') || p.identity.startsWith('agent_')) {
        void this.stop();
      }
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      const cur = useCallStore.getState().status;
      if (cur !== 'ending' && cur !== 'idle') {
        useCallStore.getState().setStatus('error', `disconnected: ${reason ?? 'unknown'}`);
      }
      this.room = null;
      this.detachRemoteAudio();
    });

    room.on(RoomEvent.DataReceived, (payload) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text) as { kind?: string; role?: string; text?: string; tool?: string; summary?: string };
        if (msg.kind === 'transcript' && msg.role && msg.text) {
          store.pushTranscript({
            role: msg.role === 'user' ? 'user' : 'agent',
            text: msg.text,
            ts: Date.now(),
          });
        } else if (msg.kind === 'awaiting_confirm' && msg.tool) {
          store.setAwaitingConfirm({ tool: msg.tool, summary: msg.summary ?? msg.tool });
        } else if (msg.kind === 'confirm_resolved') {
          store.setAwaitingConfirm(null);
        } else if (msg.kind === 'unlock_active') {
          store.setUnlockActive(true);
        }
      } catch {
        // non-JSON or unrecognized payload
      }
    });

    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Disconnected || state === ConnectionState.Reconnecting) {
        // handled by Disconnected event already
      }
    });
  }

  private attachRemoteAudio(track: RemoteAudioTrack, _p: RemoteParticipant): void {
    this.detachRemoteAudio();
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    track.attach(el);
    this.remoteAudioEl = el;
  }

  private detachRemoteAudio(): void {
    if (this.remoteAudioEl) {
      try {
        this.remoteAudioEl.remove();
      } catch {
        // ignore
      }
      this.remoteAudioEl = null;
    }
  }
}

// Singleton — one CallService for the whole app
let _service: CallService | null = null;
export function getCallService(): CallService {
  if (!_service) _service = new CallService();
  return _service;
}

export function resetCallService(): void {
  _service = null;
}
