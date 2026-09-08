import { Session, User } from '@supabase/supabase-js';
export interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}
interface DeviceData {
    user_id: string;
    device_name: string;
    capabilities: any;
    status: string;
    last_seen: string;
}
export declare class RemoteChannel {
    private client;
    private channel;
    private heartbeatInterval;
    private connectionCheckInterval;
    private deviceId;
    private onToolCall;
    private lastDeviceStatus;
    private lastChannelState;
    private reconnectAttempt;
    private isRecreatingChannel;
    private joiningSince;
    private _user;
    get user(): User | null;
    initialize(url: string, key: string): void;
    setSession(session: AuthSession): Promise<{
        error: any;
    }>;
    getSession(): Promise<{
        data: {
            session: Session | null;
        };
        error: any;
    }>;
    findDevice(deviceId: string): Promise<{
        id: any;
        device_name: any;
    } | null>;
    updateDevice(deviceId: string, updates: any): Promise<{
        data: any[] | null;
        error: import("@supabase/postgrest-js").PostgrestError | null;
    }>;
    createDevice(deviceData: DeviceData): Promise<{
        data: any;
        error: null;
    }>;
    registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void>;
    /**
     * Create and subscribe to the channel.
     * This is used for both initial subscription and recreation after socket reconnects.
     */
    private createChannel;
    /**
     * Compact connection state for logs — e.g. "socket=open(1) ch=errored attempt=3".
     * readyState 1=OPEN (a 1 while joins keep failing = a half-open socket being reused),
     * 3=CLOSED, '-'=no socket. Reads realtime-js internals defensively; never throws.
     */
    private connState;
    /**
     * Check if channel is connected, recreate if not.
     */
    private checkConnectionHealth;
    /**
     * Run an async op but reject if it doesn't settle within `ms`, so a hung await
     * can't leave isRecreatingChannel stuck true and disable the watchdog. Mirrors
     * closeWithTimeout() in desktop-commander-integration.ts.
     */
    private withTimeout;
    /**
     * Recreate the channel by destroying old one and creating fresh instance.
     */
    private recreateChannel;
    markCallExecuting(callId: string): Promise<void>;
    updateCallResult(callId: string, status: string, result?: any, errorMessage?: string | null): Promise<void>;
    updateHeartbeat(deviceId: string): Promise<void>;
    startHeartbeat(deviceId: string): void;
    stopHeartbeat(): void;
    setOnlineStatus(deviceId: string, status: 'online' | 'offline'): Promise<void>;
    setOffline(deviceId: string | undefined): Promise<void>;
    unsubscribe(): Promise<void>;
}
export {};
