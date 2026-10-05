/** An ephemeral proof issued only by the boot owner after cloud teardown and persistence. */
export type LocalAccountReadyReceipt = Readonly<{
  accountId: string;
  persistenceGeneration: number;
  generation: number;
}>;

let generation = 0;
let ready: LocalAccountReadyReceipt | null = null;
const listeners = new Set<() => void>();

export function getLocalAccountReadyReceipt(): LocalAccountReadyReceipt | null {
  return ready;
}

export function subscribeLocalAccountReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function revokeLocalAccountReadiness(): number {
  generation += 1;
  ready = null;
  listeners.forEach((listener) => listener());
  return generation;
}

/** The caller must recheck its boot/cloud/scope authority after the barrier settles. */
export async function settleLocalAccountReadiness(input: {
  accountId: string;
  persistenceGeneration: number;
  teardown: Promise<void>;
  isCurrent: () => boolean;
}): Promise<void> {
  const request = revokeLocalAccountReadiness();
  try {
    await input.teardown;
  } catch {
    return;
  }
  if (
    request !== generation ||
    !input.isCurrent() ||
    request !== generation ||
    !input.accountId.trim()
  )
    return;
  ready = Object.freeze({
    accountId: input.accountId,
    persistenceGeneration: input.persistenceGeneration,
    generation: request,
  });
  listeners.forEach((listener) => listener());
}
