export interface OpenCodeTurnToken {
  chatId: string;
  turnId: string;
  generation: number;
}

function clean(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

/**
 * Prevents cancelled/superseded SSE, tool or child-session events from being
 * committed into a newer VibeSpace turn.
 */
export class OpenCodeTurnGate {
  readonly #generationByChat = new Map<string, number>();
  readonly #activeByChat = new Map<string, OpenCodeTurnToken>();

  begin(chatId: string, turnId: string): OpenCodeTurnToken {
    const chat = clean(chatId, 'chat_id');
    const turn = clean(turnId, 'turn_id');
    const generation = (this.#generationByChat.get(chat) ?? 0) + 1;
    this.#generationByChat.set(chat, generation);
    const token = Object.freeze({ chatId: chat, turnId: turn, generation });
    this.#activeByChat.set(chat, token);
    return token;
  }

  isCurrent(token: Readonly<OpenCodeTurnToken>): boolean {
    const active = this.#activeByChat.get(token.chatId);
    return Boolean(
      active
      && active.turnId === token.turnId
      && active.generation === token.generation,
    );
  }

  assertCurrent(token: Readonly<OpenCodeTurnToken>): void {
    if (!this.isCurrent(token)) throw new Error('HARNESS_TURN_SUPERSEDED');
  }

  finish(token: Readonly<OpenCodeTurnToken>): boolean {
    if (!this.isCurrent(token)) return false;
    this.#activeByChat.delete(token.chatId);
    return true;
  }

  cancel(chatId: string): void {
    const chat = clean(chatId, 'chat_id');
    this.#generationByChat.set(chat, (this.#generationByChat.get(chat) ?? 0) + 1);
    this.#activeByChat.delete(chat);
  }

  clear(): void {
    this.#activeByChat.clear();
    this.#generationByChat.clear();
  }
}
