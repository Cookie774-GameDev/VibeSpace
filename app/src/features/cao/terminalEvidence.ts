import { sanitizePersistedTerminalText } from '@/features/terminals/terminalContentSanitizer';
type Identity = { accountId: string; projectId: string; paneId: string; sessionId: string };
const readers = new Map<string, { identity: Identity; read(): string }>();

export function registerCaoTerminalEvidence(identity: Identity, read: () => string) {
  const entry = { identity: { ...identity }, read };
  readers.set(identity.sessionId, entry);
  return () => {
    if (readers.get(identity.sessionId) === entry) readers.delete(identity.sessionId);
  };
}
export function readCaoTerminalEvidence(identity: Identity): string | undefined {
  const entry = readers.get(identity.sessionId);
  if (
    !entry ||
    Object.keys(identity).some(
      (key) => identity[key as keyof Identity] !== entry.identity[key as keyof Identity],
    )
  )
    return;
  return sanitizePersistedTerminalText(entry.read(), { maxBytes: 16000, maxLines: 120 }).text;
}
export function cleanCaoTerminalHistory(text: string) {
  const clean = text
    .replace(/[\u2500-\u25ff\u2800-\u28ff\u2b00-\u2bff]{8,}/gu, ' ')
    .replace(/[^\S\r\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n');
  return sanitizePersistedTerminalText(clean, { maxBytes: 24000, maxLines: 500 }).text;
}
