export type CredentialMap = Readonly<Record<string, string>>;

export interface CredentialHydrationResult {
  generation: number;
  values: CredentialMap;
  stale: boolean;
  lastVerifiedAt?: number;
  warning?: 'timeout' | 'failed' | 'superseded';
}

function sanitizeCredentials(values: Record<string, string | null | undefined>): CredentialMap {
  const output: Record<string, string> = {};
  for (const [rawProvider, rawValue] of Object.entries(values).slice(0, 256)) {
    const provider = rawProvider.trim();
    const value = rawValue?.trim() ?? '';
    if (!provider || provider.length > 128 || /[\u0000-\u001f\u007f]/u.test(provider)) continue;
    if (value) output[provider] = value;
  }
  return Object.freeze(output);
}

/**
 * Non-destructive credential hydration. Timeout/failure/superseded work never
 * replaces the last verified in-memory snapshot with empty or partial values.
 */
export class CredentialHydrationSnapshot {
  private requestGeneration = 0;
  private verifiedGeneration = 0;
  private snapshot: CredentialMap = Object.freeze({});
  private lastVerifiedAt: number | undefined;
  private stale = false;
  private warning: CredentialHydrationResult['warning'];

  constructor(
    private readonly timeoutMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error('invalid_credential_hydration_timeout');
    }
  }

  current(): CredentialHydrationResult {
    return {
      generation: this.verifiedGeneration,
      values: this.snapshot,
      stale: this.stale,
      ...(this.lastVerifiedAt !== undefined ? { lastVerifiedAt: this.lastVerifiedAt } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  async hydrate(
    loader: (signal?: AbortSignal) => Promise<Record<string, string | null | undefined>>,
    options: { mode?: 'replace' | 'merge' } = {},
  ): Promise<CredentialHydrationResult> {
    const generation = ++this.requestGeneration;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        loader(controller.signal).then((values) => ({ type: 'values' as const, values })),
        new Promise<{ type: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ type: 'timeout' }), this.timeoutMs);
        }),
      ]);

      if (generation !== this.requestGeneration) {
        return {
          generation,
          values: this.snapshot,
          stale: true,
          ...(this.lastVerifiedAt !== undefined ? { lastVerifiedAt: this.lastVerifiedAt } : {}),
          warning: 'superseded',
        };
      }
      if (result.type === 'timeout') {
        controller.abort();
        this.stale = true;
        this.warning = 'timeout';
        return this.current();
      }

      // A successful empty result is authoritative in replace mode (for
      // example, user removed all keys). Provider-scoped refreshes must use
      // merge mode so one successful partial probe cannot erase unrelated
      // credentials.
      const hydrated = sanitizeCredentials(result.values);
      this.snapshot = options.mode === 'merge'
        ? Object.freeze({ ...this.snapshot, ...hydrated })
        : hydrated;
      this.verifiedGeneration = generation;
      this.lastVerifiedAt = this.now();
      this.stale = false;
      this.warning = undefined;
      return this.current();
    } catch {
      if (generation === this.requestGeneration) {
        this.stale = true;
        this.warning = 'failed';
      }
      return {
        ...this.current(),
        ...(generation !== this.requestGeneration ? { warning: 'superseded' as const, stale: true } : {}),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Merge an already-authoritative in-memory/user mutation into the verified
   * snapshot and supersede any slower hydration that began before it. This is
   * the production bridge used by the auth store so a late keychain read can
   * never overwrite a key the user just added, changed, or removed.
   */
  mergeVerified(values: Record<string, string | null | undefined>): CredentialHydrationResult {
    const hydrated = sanitizeCredentials(values);
    this.requestGeneration += 1;
    this.verifiedGeneration = this.requestGeneration;
    this.snapshot = Object.freeze({ ...this.snapshot, ...hydrated });
    this.lastVerifiedAt = this.now();
    this.stale = false;
    this.warning = undefined;
    return this.current();
  }

  /** Explicit removal after the user deletes/revokes exact provider keys. */
  removeProviders(providerIds: readonly string[]): CredentialHydrationResult {
    const remove = new Set(providerIds.map((value) => value.trim()).filter(Boolean));
    this.requestGeneration += 1;
    this.verifiedGeneration = this.requestGeneration;
    this.snapshot = Object.freeze(
      Object.fromEntries(Object.entries(this.snapshot).filter(([provider]) => !remove.has(provider))),
    );
    this.lastVerifiedAt = this.now();
    this.stale = false;
    this.warning = undefined;
    return this.current();
  }

  /** Explicit user/account action only. Never call this because hydration timed out. */
  clear(): void {
    this.requestGeneration += 1;
    this.verifiedGeneration = this.requestGeneration;
    this.snapshot = Object.freeze({});
    this.lastVerifiedAt = this.now();
    this.stale = false;
    this.warning = undefined;
  }
}

export function redactCredentialMap(values: CredentialMap): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((provider) => [provider, '[REDACTED]']));
}
