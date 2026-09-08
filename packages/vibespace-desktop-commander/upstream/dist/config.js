import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
const CONFIG_DIR = fileURLToPath(new URL('../.candidate-state/', import.meta.url));
// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB
export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds
