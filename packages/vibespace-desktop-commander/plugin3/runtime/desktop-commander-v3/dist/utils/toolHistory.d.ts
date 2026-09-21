import { ServerResult } from '../types.js';
export interface ToolCallRecord {
    timestamp: string;
    toolName: string;
    arguments: any;
    output: ServerResult;
    duration?: number;
}
interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
    timestamp: string;
}
declare class ToolHistory {
    private history;
    private readonly MAX_ENTRIES;
    private readonly MAX_HISTORY_FILE_SIZE_BYTES;
    private readonly HISTORY_FILE_TRIM_TARGET_BYTES;
    private readonly historyFile;
    private writeQueue;
    private isWriting;
    private writeInterval?;
    constructor();
    /**
     * Load history from disk (all instances share the same file)
     */
    private loadFromDisk;
    /**
     * Trim the on-disk history file to stay under the size cap by dropping the
     * oldest entries (lines) until the kept tail fits within the trim target.
     * Returns true only when the file was actually rewritten with a smaller
     * tail, so callers can fall through to their normal path on failure or
     * no-op rather than mutating in-memory state.
     *
     * Always keeps at least the most recent entry, even if a single record
     * exceeds the trim target — there is no useful state below that.
     */
    private trimHistoryFileIfTooLarge;
    /**
     * Trim history file to prevent it from growing indefinitely
     */
    private trimHistoryFile;
    /**
     * Async write processor - batches writes to avoid blocking
     */
    private startWriteProcessor;
    /**
     * Flush queued writes to disk
     */
    private flushToDisk;
    /**
     * Add a tool call to history
     */
    addCall(toolName: string, args: any, output: ServerResult, duration?: number): void;
    /**
     * Get recent tool calls with filters
     */
    getRecentCalls(options: {
        maxResults?: number;
        toolName?: string;
        since?: string;
    }): ToolCallRecord[];
    /**
     * Get recent calls formatted with local timezone
     */
    getRecentCallsFormatted(options: {
        maxResults?: number;
        toolName?: string;
        since?: string;
    }): FormattedToolCallRecord[];
    /**
     * Get current stats
     */
    getStats(): {
        totalEntries: number;
        oldestEntry: string;
        newestEntry: string;
        historyFile: string;
        queuedWrites: number;
    };
    /**
     * Cleanup method - clears interval and flushes pending writes
     * Call this during shutdown or in tests
     */
    cleanup(): Promise<void>;
}
export declare const toolHistory: ToolHistory;
export {};
