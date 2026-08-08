import { PLUGIN_CATALOG } from './catalog';
import type { PluginManifest } from './types';

export type PluginConnectionClass =
  | 'official_one_click'
  | 'official_backend'
  | 'official_connector'
  | 'community_review'
  | 'manual_credential'
  | 'unsupported';

export type PluginRedirectMethod =
  | 'loopback'
  | 'custom_uri_or_loopback'
  | 'hosted_callback'
  | 'provider_managed'
  | 'not_applicable';

export type CapabilityFinding = 'supported' | 'not_supported' | 'not_selected';
export type PluginCoverageDisposition =
  | 'shipped_manual'
  | 'shipped_connector'
  | 'registration_required'
  | 'unsupported';

export interface PluginCompatibilityEntry {
  id: string;
  name: string;
  category: string;
  officialDocumentation: string;
  connectionClass: PluginConnectionClass;
  protocol: 'oauth2_pkce' | 'oauth2_backend' | 'official_mcp' | 'api_credential' | 'none';
  redirectMethod: PluginRedirectMethod;
  publicDesktopClient: boolean;
  requiredScopes: readonly string[];
  highRiskScopes: readonly string[];
  refresh: string;
  revocation: string;
  expiration: string;
  disconnect: string;
  productionRequirement: string;
  oneClickReady: boolean;
  implementationPath: 'system_browser' | 'hosted_callback' | 'provider_surface' | 'credential_form' | 'none';
  coverageDisposition: PluginCoverageDisposition;
  capabilities: Readonly<{
    oauth2: CapabilityFinding;
    oauth21: CapabilityFinding;
    pkce: CapabilityFinding;
    deviceAuthorization: CapabilityFinding;
    appInstallation: CapabilityFinding;
    officialApi: CapabilityFinding;
    officialSdk: CapabilityFinding;
    officialMcp: CapabilityFinding;
  }>;
  externalPrerequisites: readonly string[];
  communityImplementation: Readonly<{
    selected: false;
    securityReview: 'not_applicable';
    licenseReview: 'not_applicable';
  }>;
  tokenStorage: 'os_secure_store' | 'provider_managed' | 'not_applicable';
  rationale: string;
  verifiedOn: string;
}

const HIGH_RISK_SCOPE = /(?:admin|manage|write|full|compose|send|delete|payment)/i;

function connectionClass(plugin: PluginManifest): PluginConnectionClass {
  if (plugin.status === 'blocked' || plugin.status === 'planned') return 'unsupported';
  if (plugin.id === 'zapier' || plugin.authType === 'none') return 'official_connector';
  if (plugin.authType !== 'oauth') return 'manual_credential';
  if (plugin.category === 'Google Workspace' || plugin.category === 'Microsoft 365') {
    return 'official_one_click';
  }
  return 'official_backend';
}

function entry(plugin: PluginManifest): PluginCompatibilityEntry {
  const classification = connectionClass(plugin);
  const nativePublic =
    classification === 'official_one_click' &&
    (plugin.category === 'Google Workspace' || plugin.category === 'Microsoft 365');
  const scopes = Object.freeze([...(plugin.requiredScopes ?? [])]);
  const documentation =
    plugin.docsUrl ?? plugin.credentialUrl ?? 'https://github.com/Cookie774-GameDev/VibeSpace';
  const isConnector = classification === 'official_connector';
  const isOAuth = classification === 'official_one_click' || classification === 'official_backend';
  const hasShippedCredentialForm =
    plugin.fields.length > 0 &&
    plugin.status !== 'blocked' &&
    plugin.status !== 'planned';
  const externalPrerequisites = [
    ...(classification === 'official_one_click'
      ? ['Registered production desktop application', 'Provider consent-screen approval when required']
      : []),
    ...(classification === 'official_backend'
      ? ['Registered confidential application', 'Hosted VibeSpace callback service']
      : []),
    ...(plugin.limitations?.match(/review|partnership|paid|plan|assessment/i)
      ? [plugin.limitations]
      : []),
  ];

  return Object.freeze({
    id: plugin.id,
    name: plugin.name,
    category: plugin.category,
    officialDocumentation: documentation,
    connectionClass: classification,
    protocol: isConnector
      ? plugin.id === 'zapier'
        ? 'official_mcp'
        : 'none'
      : classification === 'official_one_click'
        ? 'oauth2_pkce'
        : classification === 'official_backend'
          ? 'oauth2_backend'
          : classification === 'unsupported'
            ? 'none'
            : 'api_credential',
    redirectMethod: nativePublic
      ? plugin.category === 'Google Workspace'
        ? 'loopback'
        : 'custom_uri_or_loopback'
      : classification === 'official_backend'
        ? 'hosted_callback'
        : isConnector
          ? 'provider_managed'
          : 'not_applicable',
    publicDesktopClient: nativePublic,
    requiredScopes: scopes,
    highRiskScopes: Object.freeze(scopes.filter((scope) => HIGH_RISK_SCOPE.test(scope))),
    refresh: isOAuth
      ? 'Refresh grants remain in secure platform credential storage; access tokens are rotated before expiry.'
      : 'Provider-specific credential rotation is required.',
    revocation: isOAuth
      ? 'Revoke through the provider endpoint when supported, then delete the local secure grant.'
      : 'Revoke or rotate the credential in the official provider console.',
    expiration: isOAuth
      ? 'Expired or invalid grants transition to Reauthorize without retry loops.'
      : 'Authentication failures transition to Expired or Error and require credential review.',
    disconnect:
      'Disable tool exposure first, attempt provider revocation where available, delete secure credentials, then remove account metadata.',
    productionRequirement: nativePublic
      ? 'A registered production desktop application and provider consent-screen review may be required.'
      : classification === 'official_backend'
        ? 'A confidential VibeSpace callback service, registered OAuth application, and any provider review or partnership are required.'
        : classification === 'official_connector'
          ? 'Use the provider-owned connector terms and authorization surface.'
          : classification === 'manual_credential'
            ? 'A least-privilege user credential and any provider plan required for API access.'
            : 'No safe supported production flow is currently approved.',
    // A documented protocol is not a production registration. The current
    // catalog deliberately exposes the shipped credential/connector path
    // until a provider-specific registration is configured and tested.
    oneClickReady: false,
    implementationPath: isConnector
      ? 'provider_surface'
      : hasShippedCredentialForm
        ? 'credential_form'
        : 'none',
    coverageDisposition: isConnector
      ? 'shipped_connector'
      : hasShippedCredentialForm
        ? 'shipped_manual'
        : classification === 'official_one_click' || classification === 'official_backend'
          ? 'registration_required'
          : 'unsupported',
    capabilities: Object.freeze({
      oauth2: isOAuth ? 'supported' : 'not_selected',
      oauth21: 'not_selected',
      pkce: nativePublic ? 'supported' : isOAuth ? 'not_selected' : 'not_supported',
      deviceAuthorization:
        plugin.category === 'Microsoft 365' && isOAuth ? 'supported' : 'not_selected',
      appInstallation: 'not_selected',
      officialApi: plugin.docsUrl ? 'supported' : 'not_selected',
      officialSdk: 'not_selected',
      officialMcp: plugin.id === 'zapier' ? 'supported' : 'not_selected',
    }),
    externalPrerequisites: Object.freeze(externalPrerequisites),
    communityImplementation: Object.freeze({
      selected: false,
      securityReview: 'not_applicable',
      licenseReview: 'not_applicable',
    }),
    tokenStorage: isConnector
      ? 'provider_managed'
      : classification === 'unsupported'
        ? 'not_applicable'
        : 'os_secure_store',
    rationale:
      classification === 'manual_credential'
        ? 'The catalog has a documented official API credential flow but no approved public-client authorization path.'
        : classification === 'official_backend'
          ? 'Official OAuth exists, but the configured flow requires a confidential client or hosted callback.'
          : classification === 'official_one_click'
            ? 'Official installed-app authorization supports a system browser and PKCE.'
            : classification === 'official_connector'
              ? 'The provider or VibeSpace supplies the connection surface without copying an OAuth implementation.'
              : 'No safe supported connection is currently declared.',
    verifiedOn: '2026-08-02',
  });
}

export const PLUGIN_COMPATIBILITY_MATRIX: readonly PluginCompatibilityEntry[] = Object.freeze(
  PLUGIN_CATALOG.map(entry),
);

export const PLUGIN_COMPATIBILITY_BY_ID: Readonly<Record<string, PluginCompatibilityEntry>> =
  Object.freeze(Object.fromEntries(PLUGIN_COMPATIBILITY_MATRIX.map((item) => [item.id, item])));
