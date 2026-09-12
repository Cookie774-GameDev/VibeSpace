import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JarvisContact,
  JarvisContactDraft,
  ThirdPartyCallDraft,
  ThirdPartyCallJob,
} from './types';

type InvokeClient = Pick<SupabaseClient, 'functions'>;

function idempotencyKey(): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `call-${suffix}`.slice(0, 128);
}

export class ThirdPartyCallError extends Error {
  readonly availableCredits?: number;

  constructor(code: string, availableCredits?: number) {
    super(code);
    this.name = 'ThirdPartyCallError';
    this.availableCredits = availableCredits;
  }
}

function safeError(data: unknown, fallback?: string): ThirdPartyCallError {
  const code =
    data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : null;
  const availableCredits =
    data &&
    typeof data === 'object' &&
    'availableCredits' in data &&
    typeof data.availableCredits === 'number'
      ? data.availableCredits
      : undefined;
  return new ThirdPartyCallError(code ?? fallback ?? 'call_request_failed', availableCredits);
}

export function createThirdPartyCallClient(client: InvokeClient) {
  async function invoke(
    action: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<ThirdPartyCallJob> {
    const { data, error } = await client.functions.invoke('third-party-call', {
      body: { action, ...body },
      headers,
    });
    if (error) throw safeError(data, error.message);
    const job =
      data && typeof data === 'object' && 'job' in data
        ? (data.job as ThirdPartyCallJob | null)
        : null;
    if (!job?.id) throw safeError(data, 'invalid_call_response');
    return job;
  }

  return {
    prepare: (draft: ThirdPartyCallDraft) =>
      invoke('prepare', draft as unknown as Record<string, unknown>, {
        'Idempotency-Key': idempotencyKey(),
      }),
    approve: (jobId: string) => invoke('approve', { jobId }),
    start: (jobId: string) => invoke('start', { jobId }),
    get: (jobId: string) => invoke('get', { jobId }),
    cancel: (jobId: string) => invoke('cancel', { jobId }),
    approveLive: (jobId: string) => invoke('approve-live', { jobId }),
    declineLive: (jobId: string) => invoke('decline-live', { jobId }),
    listContacts: async (): Promise<JarvisContact[]> => {
      const { data, error } = await client.functions.invoke('third-party-call', {
        body: { action: 'list-contacts' },
      });
      if (error) throw safeError(data, error.message);
      return data && typeof data === 'object' && 'contacts' in data && Array.isArray(data.contacts)
        ? (data.contacts as JarvisContact[]).slice(0, 20)
        : [];
    },
    listHistory: async (): Promise<ThirdPartyCallJob[]> => {
      const { data, error } = await client.functions.invoke('third-party-call', {
        body: { action: 'history' },
      });
      if (error) throw safeError(data, error.message);
      return data && typeof data === 'object' && 'history' in data && Array.isArray(data.history)
        ? (data.history as ThirdPartyCallJob[]).slice(0, 20)
        : [];
    },
    saveContact: async (draft: JarvisContactDraft): Promise<JarvisContact> => {
      const { data, error } = await client.functions.invoke('third-party-call', {
        body: { action: 'contact', ...draft },
      });
      if (error) throw safeError(data, error.message);
      const contact =
        data && typeof data === 'object' && 'contact' in data
          ? (data.contact as JarvisContact | null)
          : null;
      if (!contact?.id) throw safeError(data, 'invalid_contact_response');
      return contact;
    },
  };
}
