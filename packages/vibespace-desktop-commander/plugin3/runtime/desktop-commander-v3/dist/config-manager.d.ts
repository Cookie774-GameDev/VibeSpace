export interface ServerConfig {
    blockedCommands?: string[];
    defaultShell?: string;
    allowedDirectories?: string[];
    telemetryEnabled?: boolean;
    fileWriteLineLimit?: number;
    fileReadLineLimit?: number;
    clientId?: string;
    currentClient?: ClientInfo;
    [key: string]: any;
}
export interface ClientInfo {
    name: string;
    version: string;
}
export declare function normalizeTelemetryEnabledValue(value: unknown): unknown;
export declare function isTelemetryDisabledValue(value: unknown): boolean;
/**
 * Singleton config manager for the server
 */
declare class ConfigManager {
    private configPath;
    private config;
    private initialized;
    private _isFirstRun;
    private writeChain;
    private saveScheduled;
    constructor();
    /**
     * Initialize configuration - load from disk or create default
     */
    init(): Promise<void>;
    /**
     * Alias for init() to maintain backward compatibility
     */
    loadConfig(): Promise<void>;
    /**
     * Create default configuration
     */
    private getDefaultConfig;
    /**
     * Write the current in-memory config to disk. All writes funnel through
     * writeChain (see saveConfig / scheduleSave) so overlapping saves can never
     * interleave and corrupt the file. Previously every tool call could fire its
     * own independent fs.writeFile of the same path.
     */
    private writeConfigToDisk;
    /**
     * Awaitable save, serialized on writeChain. Use for explicit, user-driven
     * config changes where the caller wants on-disk confirmation.
     */
    private saveConfig;
    /**
     * Non-blocking, coalesced save. Returns immediately; the write runs in the
     * background. A burst of calls collapses to at most one queued write behind
     * the in-flight one, so a storm of tool calls can't storm the disk — and,
     * critically, can't pile up behind a saturated libuv threadpool and gate the
     * tool-call response path. Used for high-frequency, non-critical persistence
     * such as usage stats.
     */
    scheduleSave(): void;
    /**
     * Get the entire config
     */
    getConfig(): Promise<ServerConfig>;
    /**
     * Get a specific configuration value
     */
    getValue(key: string): Promise<any>;
    /**
     * Set a specific configuration value
     */
    setValue(key: string, value: any): Promise<void>;
    /**
     * Update a value in memory and persist it WITHOUT blocking the caller.
     * The tool-call response path must never wait on a disk write: when the libuv
     * threadpool is saturated (e.g. many parallel reads stalled on a slow/cloud
     * filesystem) an awaited write can't get a thread and would hang the response
     * of even pure-memory tools. The in-memory value is updated synchronously so
     * subsequent reads see it immediately; the write is coalesced in the
     * background. Callers needing on-disk confirmation should use setValue.
     */
    setValueNonBlocking(key: string, value: any): Promise<void>;
    /**
     * Update multiple configuration values at once
     */
    updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig>;
    /**
     * Reset configuration to defaults
     */
    resetConfig(): Promise<ServerConfig>;
    /**
     * Check if this is the first run (config file was just created)
     */
    isFirstRun(): boolean;
    /**
     * Get or create a persistent client ID for analytics and A/B tests
     */
    getOrCreateClientId(): Promise<string>;
}
export declare const configManager: ConfigManager;
export {};
