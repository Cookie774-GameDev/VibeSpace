import { PostHog } from 'posthog-node';
import { platform } from 'os';
let _client = null;
function getClient() {
    if (!_client) {
        _client = new PostHog(process.env.POSTHOG_API_KEY ?? '', {
            host: process.env.POSTHOG_HOST,
            enableExceptionAutocapture: true,
        });
    }
    return _client;
}
/**
 * Capture a PostHog event. Silently no-ops if POSTHOG_API_KEY is not set
 * or if telemetry has been disabled by the user.
 */
export async function capturePostHog(distinctId, event, properties) {
    if (!process.env.POSTHOG_API_KEY)
        return;
    try {
        // Respect the user's telemetry preference
        const { configManager, isTelemetryDisabledValue } = await import('../config-manager.js');
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (isTelemetryDisabledValue(telemetryEnabled))
            return;
        let VERSION = 'unknown';
        try {
            const { VERSION: v } = await import('../version.js');
            VERSION = v;
        }
        catch {
            // Continue without version
        }
        getClient().capture({
            distinctId,
            event,
            properties: {
                platform: platform(),
                app_version: VERSION,
                ...properties,
            },
        });
    }
    catch {
        // Silently fail — analytics must never break functionality
    }
}
/**
 * Identify a user by their distinct ID and set person properties.
 */
export async function identifyPostHog(distinctId, properties) {
    if (!process.env.POSTHOG_API_KEY)
        return;
    try {
        const { configManager, isTelemetryDisabledValue } = await import('../config-manager.js');
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (isTelemetryDisabledValue(telemetryEnabled))
            return;
        getClient().identify({ distinctId, properties });
    }
    catch {
        // Silently fail
    }
}
/**
 * Capture an exception via PostHog error tracking.
 */
export async function captureExceptionPostHog(error, distinctId, additionalProperties) {
    if (!process.env.POSTHOG_API_KEY)
        return;
    try {
        const { configManager, isTelemetryDisabledValue } = await import('../config-manager.js');
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (isTelemetryDisabledValue(telemetryEnabled))
            return;
        getClient().captureException(error, distinctId, additionalProperties);
    }
    catch {
        // Silently fail
    }
}
/**
 * Flush all pending PostHog events. Call before process exit.
 */
export async function shutdownPostHog() {
    if (_client) {
        try {
            await _client.shutdown();
        }
        catch {
            // Silently fail
        }
    }
}
