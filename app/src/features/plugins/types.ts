export type PluginStatus =
  | 'implemented'
  | 'configurable'
  | 'planned'
  | 'blocked'
  | 'needs_credentials';

export type PluginAuthType = 'token' | 'api_key' | 'oauth' | 'service_account' | 'none';

export type PluginField = {
  id: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
};

export type PluginTool = {
  name: string;
  description: string;
  readOnly: boolean;
};

/** Safe HTTP probe used by the generic connection tester. */
export type PluginHttpTest = {
  url: string;
  method?: 'GET' | 'POST';
  /** Header values may use `{{fieldId}}` placeholders from saved credentials. */
  headers?: Record<string, string>;
  body?: string;
  /** Dot-path into JSON response for account label, e.g. `login` or `data.email`. */
  accountLabelPath?: string;
  /** When true, a 2xx response is enough (empty body allowed). */
  acceptEmpty?: boolean;
};

export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  authType: PluginAuthType;
  fields: PluginField[];
  status: PluginStatus;
  docsUrl?: string;
  /** Official page to create API keys, OAuth apps, or tokens. */
  credentialUrl?: string;
  help: string;
  tools: PluginTool[];
  tags: string[];
  setupSteps: string[];
  supportedFeatures: string[];
  limitations?: string;
  /** When set, `testPluginConnection` runs this probe instead of a hard-coded switch. */
  httpTest?: PluginHttpTest;
};

export type PluginConnectionState = 'connected' | 'not_connected' | 'needs_setup' | 'error';

export type PluginConnection = {
  pluginId: string;
  state: PluginConnectionState;
  enabled: boolean;
  enabledProjectIds: string[];
  accountLabel?: string;
  lastTestedAt?: number;
  error?: string;
  configuredFields: string[];
  updatedAt: number;
};

export type PluginTestResult = {
  ok: boolean;
  accountLabel?: string;
  error?: string;
};

export function isConnectableStatus(status: PluginStatus): boolean {
  return status === 'implemented' || status === 'configurable' || status === 'needs_credentials';
}

export function supportsAutomatedTest(manifest: PluginManifest): boolean {
  return Boolean(manifest.httpTest) || manifest.status === 'implemented';
}
