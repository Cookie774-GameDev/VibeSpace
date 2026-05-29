/**
 * Database types for the hosted Jarvis tier.
 *
 * Mirror of `supabase/schema.sql` at the repo root. PostgREST serialises
 * `numeric` as a string and `timestamptz` as an ISO string - the TS types
 * reflect that shape.
 */

export type Tier = 'free' | 'plus' | 'byok-only';
export type UsageStatus = 'ok' | 'rate_limit' | 'error';

export type Profile = {
  id: string;
  display_name: string | null;
  email: string | null;
  tier: Tier;
  monthly_quota: number;
  created_at: string;
  updated_at: string;
};

export type ApiKey = {
  id: string;
  user_id: string;
  provider: string;
  label: string | null;
  encrypted: string;
  created_at: string;
};

export type UsageLog = {
  id: string;
  user_id: string;
  ts: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** numeric(10, 6) - PostgREST returns it as a string. */
  cost_usd: string | null;
  status: UsageStatus;
  latency_ms: number | null;
};

export type UsageMonthRow = {
  user_id: string;
  ok_count: number;
  /** ISO timestamp at the start of the month. */
  month: string;
};

/** Generic shape consumed by `SupabaseClient<Database>`. */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: { id: string } & Partial<Omit<Profile, 'id'>>;
        Update: Partial<Profile>;
        Relationships: [];
      };
      api_keys: {
        Row: ApiKey;
        Insert: { user_id: string; provider: string; encrypted: string } & Partial<
          Omit<ApiKey, 'user_id' | 'provider' | 'encrypted'>
        >;
        Update: Partial<ApiKey>;
        Relationships: [];
      };
      usage_log: {
        Row: UsageLog;
        Insert: {
          user_id: string;
          provider: string;
          model: string;
          status: UsageStatus;
        } & Partial<Omit<UsageLog, 'user_id' | 'provider' | 'model' | 'status'>>;
        Update: Partial<UsageLog>;
        Relationships: [];
      };
    };
    Views: {
      usage_month: {
        Row: UsageMonthRow;
        Relationships: [];
      };
    };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/** Re-export to keep call sites tidy. */
export type { SupabaseClient } from '@supabase/supabase-js';
