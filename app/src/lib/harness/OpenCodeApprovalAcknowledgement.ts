import type { HarnessApprovalResponse } from './types';

interface Binding extends HarnessApprovalResponse {
  generation: string;
}
interface Attempt {
  response: HarnessApprovalResponse['response'];
  acknowledged: boolean;
  confirm(): void;
  promise: Promise<void>;
}

/** Match a native acknowledgment, never infer acceptance from a missing permission. */
export class OpenCodeApprovalAcknowledgements {
  private readonly attempts = new Map<string, Attempt>();

  private key(generation: string, sessionId: string, approvalId: string): string {
    return JSON.stringify([generation, sessionId, approvalId]);
  }

  observe(
    generation: string,
    event: { type: string; properties?: Readonly<Record<string, unknown>> },
  ): void {
    if (event.type !== 'permission.replied') return;
    const properties = event.properties;
    if (typeof properties?.sessionID !== 'string' || typeof properties.requestID !== 'string')
      return;
    const attempt = this.attempts.get(
      this.key(generation, properties.sessionID, properties.requestID),
    );
    if (attempt && properties.reply === attempt.response) attempt.confirm();
  }

  execute(binding: Binding, send: () => Promise<void>, onAcknowledged: () => void): Promise<void> {
    const key = this.key(binding.generation, binding.sessionId, binding.approvalId);
    const existing = this.attempts.get(key);
    if (existing) {
      if (existing.response !== binding.response) {
        return Promise.reject(new Error('OpenCode approval already has a different decision.'));
      }
      return existing.acknowledged ? Promise.resolve() : existing.promise;
    }
    // Do not evict unknown outcomes and accidentally permit their mutation to replay.
    if (this.attempts.size >= 4_096)
      return Promise.reject(new Error('OpenCode approval tracking reached its safe bound.'));
    let confirm!: () => void;
    const acknowledgment = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const attempt: Attempt = {
      response: binding.response,
      acknowledged: false,
      promise: Promise.resolve(),
      confirm() {
        if (attempt.acknowledged) return;
        attempt.acknowledged = true;
        onAcknowledged();
        confirm();
      },
    };
    this.attempts.set(key, attempt);
    const dispatch = Promise.resolve()
      .then(send)
      .then(() => attempt.confirm())
      .catch(async (error) => {
        if (
          !/timed out|request failed/i.test(error instanceof Error ? error.message : String(error))
        )
          throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            acknowledgment,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'OpenCode approval outcome is unknown. Wait for its acknowledgment; do not repeat this decision.',
                    ),
                  ),
                30_000,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      });
    attempt.promise = Promise.race([dispatch, acknowledgment]);
    return attempt.promise;
  }
}
