/**
 * Capture a PostHog event. Silently no-ops if POSTHOG_API_KEY is not set
 * or if telemetry has been disabled by the user.
 */
export declare function capturePostHog(distinctId: string, event: string, properties?: Record<string, any>): Promise<void>;
/**
 * Identify a user by their distinct ID and set person properties.
 */
export declare function identifyPostHog(distinctId: string, properties?: Record<string, any>): Promise<void>;
/**
 * Capture an exception via PostHog error tracking.
 */
export declare function captureExceptionPostHog(error: unknown, distinctId?: string, additionalProperties?: Record<string, any>): Promise<void>;
/**
 * Flush all pending PostHog events. Call before process exit.
 */
export declare function shutdownPostHog(): Promise<void>;
