import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
const defaultEditorCache = new Map();
function escapeAppleScriptString(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export async function getDefaultEditorMetadata(filePath) {
    if (os.platform() !== 'darwin') {
        return {};
    }
    const extension = path.extname(filePath).toLowerCase();
    const cacheKey = extension || path.basename(filePath).toLowerCase();
    const cached = defaultEditorCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    try {
        const script = `set appAlias to default application of (info for POSIX file "${escapeAppleScriptString(filePath)}")\nreturn (name of (info for appAlias)) & linefeed & POSIX path of appAlias`;
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 12000 });
        const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        const defaultEditorName = lines[lines.length - 2]?.replace(/\.app$/i, '') ?? '';
        const defaultEditorPath = lines[lines.length - 1] ?? '';
        if (defaultEditorName && defaultEditorPath.startsWith('/')) {
            const metadata = { defaultEditorName, defaultEditorPath };
            defaultEditorCache.set(cacheKey, metadata);
            return metadata;
        }
    }
    catch {
        // Generic UI fallback is good enough if detection fails.
    }
    return {};
}
