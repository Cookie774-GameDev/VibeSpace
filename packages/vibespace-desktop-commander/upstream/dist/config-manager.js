import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import os from 'os';
import { VERSION } from './version.js';
import { CONFIG_FILE } from './config.js';
export function normalizeTelemetryEnabledValue(value) {
    if (typeof value !== 'string') {
        return value;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return value;
}
export function isTelemetryDisabledValue(value) {
    return normalizeTelemetryEnabledValue(value) === false;
}
/**
 * Singleton config manager for the server
 */
class ConfigManager {
    constructor() {
        this.config = {};
        this.initialized = false;
        this._isFirstRun = false; // Track if this is the first run (config was just created)
        // Serializes all disk writes so concurrent saves can't corrupt config.json.
        this.writeChain = Promise.resolve();
        // True while a coalesced background write is already queued (see scheduleSave).
        this.saveScheduled = false;
        // Get user's home directory
        // Define config directory and file paths
        this.configPath = CONFIG_FILE;
    }
    /**
     * Initialize configuration - load from disk or create default
     */
    async init() {
        if (this.initialized)
            return;
        try {
            // Ensure config directory exists
            const configDir = path.dirname(this.configPath);
            if (!existsSync(configDir)) {
                await mkdir(configDir, { recursive: true });
            }
            // Check if config file exists
            try {
                await fs.access(this.configPath);
                // Load existing config
                const configData = await fs.readFile(this.configPath, 'utf8');
                this.config = JSON.parse(configData);
                this._isFirstRun = false;
                // Configs created before this marker existed must not receive the
                // welcome page retroactively when client eligibility changes later.
                // New configs get this field from getDefaultConfig() and remain
                // eligible across restarts until their first initialization.
                if (this.config['welcomeOnboardingEligible'] === undefined) {
                    this.config['welcomeOnboardingEligible'] = false;
                    this.config['pendingWelcomeOnboarding'] = false;
                    await this.saveConfig();
                }
            }
            catch (error) {
                // Config file doesn't exist, create default
                this.config = this.getDefaultConfig();
                this._isFirstRun = true; // This is a first run!
                await this.saveConfig();
            }
            this.config['version'] = VERSION;
            this.initialized = true;
        }
        catch (error) {
            console.error('Failed to initialize config:', error);
            // Fall back to default config in memory
            this.config = this.getDefaultConfig();
            this.initialized = true;
        }
    }
    /**
     * Alias for init() to maintain backward compatibility
     */
    async loadConfig() {
        return this.init();
    }
    /**
     * Create default configuration
     */
    getDefaultConfig() {
        return {
            blockedCommands: [
                // Disk and partition management
                "mkfs", // Create a filesystem on a device
                "format", // Format a storage device (cross-platform)
                "mount", // Mount a filesystem
                "umount", // Unmount a filesystem
                "fdisk", // Manipulate disk partition tables
                "dd", // Convert and copy files, can write directly to disks
                "parted", // Disk partition manipulator
                "diskpart", // Windows disk partitioning utility
                // System administration and user management
                "sudo", // Execute command as superuser
                "su", // Substitute user identity
                "passwd", // Change user password
                "adduser", // Add a user to the system
                "useradd", // Create a new user
                "usermod", // Modify user account
                "groupadd", // Create a new group
                "chsh", // Change login shell
                "visudo", // Edit the sudoers file
                // System control
                "shutdown", // Shutdown the system
                "reboot", // Restart the system
                "halt", // Stop the system
                "poweroff", // Power off the system
                "init", // Change system runlevel
                // Network and security
                "iptables", // Linux firewall administration
                "firewall", // Generic firewall command
                "netsh", // Windows network configuration
                // Windows system commands
                "sfc", // System File Checker
                "bcdedit", // Boot Configuration Data editor
                "reg", // Windows registry editor
                "net", // Network/user/service management
                "sc", // Service Control manager
                "runas", // Execute command as another user
                "cipher", // Encrypt/decrypt files or wipe data
                "takeown" // Take ownership of files
            ],
            defaultShell: (() => {
                if (os.platform() === 'win32') {
                    return 'powershell.exe';
                }
                // Use user's actual shell from environment
                // On macOS, default to zsh (default since Catalina) since process.env.SHELL
                // may not be set when running inside Claude Desktop
                const fallbackShell = os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
                const userShell = process.env.SHELL || fallbackShell;
                // Return just the shell path - we'll handle login shell flag elsewhere
                return userShell;
            })(),
            allowedDirectories: [],
            telemetryEnabled: false, // Isolated candidate: disable telemetry during evaluation.
            fileWriteLineLimit: 50, // Default line limit for file write operations (changed from 100)
            fileReadLineLimit: 10000, // Larger pages with bounded text response bytes.
            pendingWelcomeOnboarding: true, // New install flag - triggers A/B test for welcome page
            welcomeOnboardingEligible: true // Distinguishes new installs from migrated legacy configs
        };
    }
    /**
     * Write the current in-memory config to disk. All writes funnel through
     * writeChain (see saveConfig / scheduleSave) so overlapping saves can never
     * interleave and corrupt the file. Previously every tool call could fire its
     * own independent fs.writeFile of the same path.
     */
    async writeConfigToDisk() {
        await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    }
    /**
     * Awaitable save, serialized on writeChain. Use for explicit, user-driven
     * config changes where the caller wants on-disk confirmation.
     */
    async saveConfig() {
        const write = this.writeChain.then(() => this.writeConfigToDisk());
        // Keep the chain alive even if this write rejects, so later writes still run.
        this.writeChain = write.catch(() => { });
        return write;
    }
    /**
     * Non-blocking, coalesced save. Returns immediately; the write runs in the
     * background. A burst of calls collapses to at most one queued write behind
     * the in-flight one, so a storm of tool calls can't storm the disk — and,
     * critically, can't pile up behind a saturated libuv threadpool and gate the
     * tool-call response path. Used for high-frequency, non-critical persistence
     * such as usage stats.
     */
    scheduleSave() {
        if (this.saveScheduled)
            return; // a queued write will capture the latest config
        this.saveScheduled = true;
        this.writeChain = this.writeChain.then(async () => {
            this.saveScheduled = false; // let the next burst queue a fresh write
            try {
                await this.writeConfigToDisk();
            }
            catch (error) {
                console.error('Failed to save config (background):', error);
            }
        });
    }
    /**
     * Get the entire config
     */
    async getConfig() {
        await this.init();
        return { ...this.config };
    }
    /**
     * Get a specific configuration value
     */
    async getValue(key) {
        await this.init();
        return this.config[key];
    }
    /**
     * Set a specific configuration value
     */
    async setValue(key, value) {
        await this.init();
        if (key === 'telemetryEnabled') {
            value = normalizeTelemetryEnabledValue(value);
        }
        // Special handling for telemetry opt-out
        if (key === 'telemetryEnabled' && isTelemetryDisabledValue(value)) {
            // Get the current value before changing it
            const currentValue = this.config[key];
            const telemetryAlreadyDisabled = isTelemetryDisabledValue(currentValue);
            // Only capture the opt-out event if telemetry was previously enabled
            if (!telemetryAlreadyDisabled) {
                // Import the capture function dynamically to avoid circular dependencies
                const { capture } = await import('./utils/capture.js');
                // Send a final telemetry event noting that the user has opted out
                // This helps us track opt-out rates while respecting the user's choice
                await capture('server_telemetry_opt_out', {
                    reason: 'user_disabled',
                    prev_value: currentValue
                });
            }
        }
        // Update the value
        this.config[key] = value;
        await this.saveConfig();
    }
    /**
     * Update a value in memory and persist it WITHOUT blocking the caller.
     * The tool-call response path must never wait on a disk write: when the libuv
     * threadpool is saturated (e.g. many parallel reads stalled on a slow/cloud
     * filesystem) an awaited write can't get a thread and would hang the response
     * of even pure-memory tools. The in-memory value is updated synchronously so
     * subsequent reads see it immediately; the write is coalesced in the
     * background. Callers needing on-disk confirmation should use setValue.
     */
    async setValueNonBlocking(key, value) {
        await this.init();
        this.config[key] = value;
        this.scheduleSave();
    }
    /**
     * Update multiple configuration values at once
     */
    async updateConfig(updates) {
        await this.init();
        this.config = { ...this.config, ...updates };
        await this.saveConfig();
        return { ...this.config };
    }
    /**
     * Reset configuration to defaults
     */
    async resetConfig() {
        this.config = this.getDefaultConfig();
        await this.saveConfig();
        return { ...this.config };
    }
    /**
     * Check if this is the first run (config file was just created)
     */
    isFirstRun() {
        return this._isFirstRun;
    }
    /**
     * Get or create a persistent client ID for analytics and A/B tests
     */
    async getOrCreateClientId() {
        let clientId = await this.getValue('clientId');
        if (!clientId) {
            const { randomUUID } = await import('crypto');
            clientId = randomUUID();
            await this.setValue('clientId', clientId);
        }
        return clientId;
    }
}
// Export singleton instance
export const configManager = new ConfigManager();
