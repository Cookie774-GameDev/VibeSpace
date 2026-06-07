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

export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  category: string;
  authType: PluginAuthType;
  fields: PluginField[];
  status: PluginStatus;
  docsUrl?: string;
  help: string;
  tools: PluginTool[];
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
