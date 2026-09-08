// Match OpenCode's sortable message identifier format:
// https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/id/id.ts
let lastTimestamp = 0;
let counter = 0;
export function newOpenCodeMessageId(): string {
  const timestamp = Date.now();
  counter = timestamp === lastTimestamp ? counter + 1 : 1;
  lastTimestamp = timestamp;
  const time = (BigInt(timestamp) * 0x1000n + BigInt(counter)) & 0xffffffffffffn;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), byte => alphabet[byte % 62]).join('');
  return `msg_${time.toString(16).padStart(12, '0')}${random}`;
}

export async function sendOpenCodePromptOnce(input: {
  sessionId: string;
  messageId: string;
  send: () => Promise<unknown>;
  messages: () => Promise<unknown>;
  now?: () => number;
  sleep?: () => Promise<void>;
}): Promise<unknown> {
  try {
    return await input.send();
  } catch (error) {
    // A rejected request is not evidence of acceptance. Only ambiguous network
    // failures warrant reconciliation, and the POST must never be repeated.
    if (!(error instanceof Error) || !/timed out|failed to fetch|network error/i.test(error.message)) throw error;
    const now = input.now ?? Date.now;
    const deadline = now() + 60_000;
    const sleep = input.sleep ?? (() => new Promise<void>(resolve => setTimeout(resolve, 500)));
    for (let attempt = 0; attempt < 12 && now() < deadline; attempt += 1) {
      const result = await input.messages().catch(() => undefined);
      if (now() >= deadline) break;
      const messages = result && typeof result === 'object' && 'data' in result ? result.data : result;
      if (Array.isArray(messages) && messages.some(message =>
        message?.info?.id === input.messageId && message.info.role === 'user' &&
        message.info.sessionID === input.sessionId,
      )) return undefined;
      await sleep();
    }
    throw error;
  }
}
