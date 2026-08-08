export interface Env {
  USER_RELAY: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  MCP_PUBLIC_URL: string;
  ALLOWED_ORIGINS: string;
  RELAY_TICKET_KEY: string;
}

export interface SupabaseIdentity {
  sub: string;
  clientId?: string;
  scopes: string[];
  expiresAt?: number;
  role?: string;
}

export interface RelayWorkspace {
  id: string;
  displayName: string;
}

export interface RelayStatus {
  connected: boolean;
  workspace?: RelayWorkspace;
  tools: string[];
  connectedAt?: number;
}

export interface RelayInvocation {
  name: 'fs.list' | 'fs.read';
  args: Record<string, unknown>;
}

export interface RelayInvocationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}
