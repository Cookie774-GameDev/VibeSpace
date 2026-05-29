import type { IntegrationId, Timestamped } from './common';

/**
 * External service integrations.
 *
 * V2 supports five kinds:
 *   - supabase  : cloud sync target (URL + anon key)
 *   - github    : Device Flow OAuth, stores token in Stronghold
 *   - google    : PKCE OAuth, stores access/refresh tokens, calendar scope
 *   - opencode  : local HTTP API at localhost:4096 (no auth)
 *   - ollama    : local HTTP API at localhost:11434 (no auth)
 *
 * Secrets never live in this row — only `secret_ref`, a key into Stronghold.
 * `config_json` carries kind-specific public config (URLs, endpoint paths,
 * default-repo selections for GitHub, etc).
 */

export type IntegrationKind = 'supabase' | 'github' | 'google' | 'opencode' | 'ollama';

export type IntegrationStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type Integration = {
  id: IntegrationId;
  kind: IntegrationKind;
  status: IntegrationStatus;
  /** Public, kind-specific config — base URLs, repo selection, port, etc. */
  config_json: Record<string, unknown>;
  /** Pointer into Stronghold/keyring; never a raw secret. */
  secret_ref: string | null;
  /** OAuth scopes granted (Google/GitHub). */
  scopes_json: string[];
  /** Unix ms — last successful pull/push. */
  last_synced_at: number | null;
  /** Unix ms — token expiry for OAuth integrations. */
  expires_at: number | null;
  error_message: string | null;
} & Timestamped;

export type IntegrationInput = Pick<Integration, 'kind'> &
  Partial<Omit<Integration, 'id' | 'created_at' | 'updated_at'>>;
