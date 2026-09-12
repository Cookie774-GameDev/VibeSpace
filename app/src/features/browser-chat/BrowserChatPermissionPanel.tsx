import {
  BROWSER_CHAT_CAPABILITIES,
  calculateCapabilityCatalog,
  permissionModeFor,
  type BrowserChatApprovalMode,
  type BrowserChatCapabilityId,
  type BrowserChatPermissionPlan,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';
import {
  CHATGPT_PROVIDER_CAPABILITY_LABELS,
  providerCapabilitiesForTier,
  type ChatGptProviderCapabilityTier,
} from './providerCapability';

const PLAN_OPTIONS: readonly {
  value: BrowserChatPermissionPlan;
  label: string;
  description: string;
}[] = [
  { value: 'off', label: 'Off', description: 'Keep the relay online without local tools.' },
  { value: 'read', label: 'Read', description: 'Allow bounded project and context reads.' },
  {
    value: 'project_developer',
    label: 'Project Developer',
    description: 'Enable project actions under their configured approval modes.',
  },
  {
    value: 'full_local_developer',
    label: 'Full Local Developer',
    description: 'Enable the broad local profile; critical actions still ask every time.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Choose an approval mode for each capability.',
  },
];

const APPROVAL_LABELS: Readonly<Record<BrowserChatApprovalMode, string>> = {
  deny: 'Always block',
  auto: 'Allow automatically',
  ask: 'Ask once this session',
  always_ask: 'Ask every time',
};

const GENERAL_MODES: readonly BrowserChatApprovalMode[] = ['deny', 'auto', 'ask', 'always_ask'];
const CRITICAL_MODES: readonly BrowserChatApprovalMode[] = ['deny', 'always_ask'];

type Props = {
  readonly profile: BrowserChatPermissionProfile;
  readonly workspaceGranted: boolean;
  readonly providerBridgeAvailable: boolean;
  readonly providerCapabilityTier?: ChatGptProviderCapabilityTier;
  readonly availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly disabled?: boolean;
  readonly onProfileChange: (profile: BrowserChatPermissionProfile) => void;
};

export function BrowserChatPermissionPanel({
  profile,
  workspaceGranted,
  providerBridgeAvailable,
  providerCapabilityTier = 'unknown',
  availableCapabilities,
  disabled = false,
  onProfileChange,
}: Props) {
  const grantedCapabilities = workspaceGranted
    ? new Set(BROWSER_CHAT_CAPABILITIES.map((capability) => capability.id))
    : new Set<BrowserChatCapabilityId>();
  const catalog = calculateCapabilityCatalog({
    profile,
    grantedCapabilities,
    availableCapabilities,
    providerCapabilities: new Set(providerCapabilitiesForTier(providerCapabilityTier)),
    providerBridgeAvailable,
  });
  const enabled = catalog.filter((entry) => entry.approvalMode !== 'deny');
  const executable = enabled.filter((entry) => entry.available);
  const providerLimited = enabled.filter(
    (entry) =>
      entry.denial?.source === 'provider' &&
      entry.denial.code === 'provider_capability_unsupported',
  ).length;
  const locallyUnavailable = enabled.filter((entry) => entry.denial?.source === 'runtime').length;
  const grantRequired = enabled.filter(
    (entry) => entry.denial?.source === 'workspace_grant',
  ).length;
  const activePlan = PLAN_OPTIONS.find((option) => option.value === profile.plan)!;

  const selectPlan = (plan: BrowserChatPermissionPlan) => {
    onProfileChange({
      ...profile,
      plan,
      overrides: {},
      updatedAt: Date.now(),
    });
  };

  const selectCustomMode = (
    capabilityId: BrowserChatCapabilityId,
    mode: BrowserChatApprovalMode,
  ) => {
    onProfileChange({
      ...profile,
      plan: 'custom',
      overrides: {
        ...profile.overrides,
        [capabilityId]: mode,
      },
      updatedAt: Date.now(),
    });
  };

  return (
    <section
      aria-label="VibeSpace MCP permissions"
      className="mt-2 rounded-md border border-border/70 bg-muted/25 p-2"
    >
      <label className="block text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Permission plan
        <select
          aria-label="VibeSpace permission plan"
          value={profile.plan}
          disabled={disabled}
          onChange={(event) => selectPlan(event.currentTarget.value as BrowserChatPermissionPlan)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-[11px] normal-case tracking-normal text-foreground"
        >
          {PLAN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{activePlan.description}</p>
      <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
        Provider support: {CHATGPT_PROVIDER_CAPABILITY_LABELS[providerCapabilityTier]}.
      </p>
      <p
        aria-live="polite"
        className="mt-2 border-l-2 border-accent-copper/70 pl-2 text-[9px] leading-4 text-muted-foreground"
      >
        <strong className="font-medium text-foreground">{executable.length} executable now</strong>
        {' · '}
        {providerLimited} limited by provider
        {' · '}
        {locallyUnavailable} unavailable locally
        {' · '}
        {grantRequired} need a project grant
        {' · '}
        {catalog.length - enabled.length} blocked by plan
      </p>

      {profile.plan === 'custom' ? (
        <div className="mt-2 grid gap-1.5 border-t border-border/60 pt-2">
          {BROWSER_CHAT_CAPABILITIES.map((capability) => {
            const modes = capability.criticalApproval ? CRITICAL_MODES : GENERAL_MODES;
            return (
              <label
                key={capability.id}
                className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-2 text-[9px] leading-4 text-muted-foreground"
              >
                <span className="truncate" title={capability.label}>
                  {capability.label}
                </span>
                <select
                  aria-label={`${capability.label} approval`}
                  value={permissionModeFor(profile, capability.id)}
                  disabled={disabled}
                  onChange={(event) =>
                    selectCustomMode(
                      capability.id,
                      event.currentTarget.value as BrowserChatApprovalMode,
                    )
                  }
                  className="h-7 min-w-0 rounded-md border border-input bg-background px-1.5 text-[9px] text-foreground"
                >
                  {modes.map((mode) => (
                    <option key={mode} value={mode}>
                      {APPROVAL_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
