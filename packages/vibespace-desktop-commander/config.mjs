export const FIELDS = [
  'blockedCommands',
  'allowedDirectories',
  'defaultShell',
  'telemetryEnabled',
  'fileReadLineLimit',
  'fileWriteLineLimit',
];
export function validateSetting(key, value) {
  if (!FIELDS.includes(key)) throw Error('Unknown configuration field');
  if (key === 'blockedCommands' || key === 'allowedDirectories') {
    if (
      !Array.isArray(value) ||
      value.length > 500 ||
      value.some(
        (v) => typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\x00-\x1f]/.test(v),
      )
    )
      throw Error('Enter up to 500 nonempty entries, one per line');
  } else if (key === 'defaultShell') {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 4096 ||
      /[\x00-\x1f]/.test(value)
    )
      throw Error('Enter a shell executable');
  } else if (key === 'telemetryEnabled') {
    if (typeof value !== 'boolean') throw Error('Telemetry must be on or off');
  } else if (!Number.isSafeInteger(value) || value < 1 || value > 1000000)
    throw Error('Line limits must be whole numbers from 1 to 1,000,000');
  return value;
}
export function editableConfig(result) {
  if (result.isError) throw Error('Desktop Commander rejected the request');
  const raw = result.structuredContent?.config;
  if (!raw) throw Error('Desktop Commander did not return configuration');
  const config = Object.fromEntries(FIELDS.map((key) => [key, validateSetting(key, raw[key])]));
  return {
    config,
    availableShells: (result.structuredContent.uiHints?.availableShells ?? []).filter(
      (s) => typeof s === 'string',
    ),
  };
}
