#!/usr/bin/env node
export interface MCPDeviceOptions {
    persistSession?: boolean;
}
export declare class MCPDevice {
    private baseServerUrl;
    private remoteChannel;
    private deviceId?;
    private isShuttingDown;
    private configPath;
    private persistSession;
    private desktop;
    constructor(options?: MCPDeviceOptions);
    private setupShutdownHandlers;
    start(): Promise<void>;
    loadPersistedConfig(): Promise<any>;
    savePersistedConfig(): Promise<void>;
    fetchSupabaseConfig(): Promise<{
        supabaseUrl: any;
        anonKey: any;
    }>;
    handleNewToolCall(payload: any): Promise<void>;
    shutdown(): Promise<void>;
}
