/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL?: string;
  readonly VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256?: string;
  readonly VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION?: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_GOOGLE_API_KEY?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_ENABLE_VOICE?: string;
  readonly VITE_ENABLE_COUNCIL?: string;
  readonly VITE_ENABLE_CLOUD_SYNC?: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_ACCESS_LEASE_PUBLIC_KEYS?: string;
  readonly VITE_GIT_COMMIT?: string;
  readonly VITE_GIT_BRANCH?: string;
  readonly VITE_BUILD_TIMESTAMP?: string;
  readonly VITE_FRONTEND_ASSET_VERSION?: string;
  readonly VITE_SIK_SMOKE?: string;
  /** Revive scrapped Hive product surfaces + multi-model stack (default off). */
  readonly VITE_HIVE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
