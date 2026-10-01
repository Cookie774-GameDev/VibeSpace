export interface JarvisEntitlementSnapshot {
  source: 'server' | 'local_development' | 'unavailable';
  planId?: string;
  capabilities: string[];
  verifiedAt?: number;
  expiresAt?: number;
}

export type JarvisActionSchemaType = 'object' | 'string' | 'number' | 'boolean' | 'array';

export interface JarvisActionJsonSchema {
  type: JarvisActionSchemaType;
  description?: string;
  properties?: Record<string, JarvisActionJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  oneOf?: JarvisActionJsonSchema[];
}

export interface JarvisActionSchemaSnapshot {
  id: string;
  version: number;
  title: string;
  description: string;
  inputSchema: JarvisActionJsonSchema;
  outputSchema: JarvisActionJsonSchema;
  requiredCapabilities: string[];
  requiredEntitlements: string[];
  risk:
    | 'read-only'
    | 'safe-write'
    | 'external-side-effect'
    | 'destructive'
    | 'credential-sensitive';
  approval: 'never' | 'first-time' | 'always' | 'depends-on-input';
  expectedEffect: string;
}

export interface JarvisCapabilitySnapshot {
  capturedAt: number;
  tools: JarvisCapabilityRef[];
  plugins: JarvisCapabilityRef[];
  mcps: JarvisCapabilityRef[];
  terminals: JarvisCapabilityRef[];
  agents: JarvisCapabilityRef[];
  entitlements: JarvisEntitlementSnapshot;
  /** Detached, model-safe schemas from the validated account action catalog. */
  actionSchemas?: JarvisActionSchemaSnapshot[];
}

export interface JarvisCapabilityRef {
  id: string;
  state: 'available' | 'connected' | 'authenticated' | 'degraded' | 'unavailable' | 'planned';
  operations: string[];
  evidenceRef?: string;
  lastVerifiedAt?: number;
}

export interface JarvisModelSnapshot {
  connectionId?: string;
  providerId: string;
  modelId: string;
  connectionMode: 'native-api' | 'external-cli' | 'local';
  capabilities: Record<string, boolean>;
  effectiveTemperature?: number;
  capturedAt: number;
}
