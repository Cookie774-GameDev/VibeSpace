import type { InstantCommand } from './types';

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;
const GO_FLASH = 'opencode-go/deepseek-v4-flash-vision-exp';
const MODEL_ALIASES = new Set([
  'deepseek v4 flash from opencode go',
  'deepseek v4 flash exp from opencode go',
  'deepseek v4 flash vision exp from opencode go',
]);

export function parseOpenCodeLaunch(source: string): InstantCommand | null {
  if (source.length > 8192 || /[\x00-\x1f\x7f]/.test(source)) return null;
  const match =
    /^(?:hey[ ,]+)?(?:please\s+)?(?:open|launch|start)\s+open\s?code(?:\s+(?:in|into)\s+a\s+new\s+terminal)?\s+and(?:\s+then)?\s+(?:send|type)(?:\s+this\s+message)?\s+(['"])(.*?)\1(?:\s+into\s+it)?(?:\s+and\s+(?:click|press|hit)\s+enter)?\s+(?:but\s+make\s+sure\s+the\s+model\s+is(?:\s+at)?|(?:using|with)(?:\s+the)?\s+model)\s+(.+?)\s*$/i.exec(
      source.trim(),
    );
  if (!match) return null;
  const prompt = match[2]!;
  const label = match[3]!.toLowerCase();
  const modelId = MODEL_ALIASES.has(label) ? GO_FLASH : match[3]!;
  if (!prompt.trim() || prompt.length > 4096 || !MODEL_ID.test(modelId)) return null;
  return { kind: 'open-agent-cli', provider: 'opencode', count: 1, modelId, prompt };
}

export function openCodeLaunchCommand(modelId: string, prompt: string): string | null {
  if (
    !MODEL_ID.test(modelId) ||
    !prompt.trim() ||
    prompt.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(prompt)
  )
    return null;
  // Fresh Windows panes use PowerShell; POSIX shells use standard single quoting.
  const windows = /Win/i.test(navigator.platform || navigator.userAgent);
  const quote = (value: string) =>
    windows ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`;
  const launch = `opencode --model ${quote(modelId)} --prompt ${quote(prompt)}`;
  const provider = quote(modelId.split('/')[0]!);
  const unavailable = quote('Requested OpenCode model is unavailable; message not sent.');
  // OpenCode can fall back to its default when a requested provider is missing.
  // Validate the exact model in this terminal's own profile before submitting.
  return windows
    ? `$jarvisLaunchModels = @(opencode models ${provider}); if ($LASTEXITCODE -ne 0 -or $jarvisLaunchModels -cnotcontains ${quote(modelId)}) { Write-Error ${unavailable} } else { ${launch} }`
    : `if opencode models ${provider} | grep -Fx -- ${quote(modelId)} >/dev/null; then ${launch}; else printf '%s\\n' ${unavailable} >&2; fi`;
}
