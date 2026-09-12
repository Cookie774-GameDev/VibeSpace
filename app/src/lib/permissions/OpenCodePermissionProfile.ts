export type InteractionMode = 'ask' | 'plan' | 'agent';
export type AccessLevel = 'read-only' | 'write' | 'full';
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type MutationAuthority =
  | 'none'
  | 'exact-request'
  | 'plan-artifacts'
  | 'autonomous';

export type TerminalAuthority =
  | 'none'
  | 'exact-request'
  | 'inspection-only'
  | 'autonomous';

export interface PermissionProfileInput {
  mode: InteractionMode;
  access: AccessLevel;
  approveAllForRun: boolean;
  projectRoot: string;
}

export interface OpenCodePermissionProfile {
  read: Readonly<Record<string, PermissionDecision>>;
  edit: Readonly<Record<string, PermissionDecision>>;
  bash: PermissionDecision;
  task: PermissionDecision;
  skill: PermissionDecision;
  webfetch: PermissionDecision;
  websearch: PermissionDecision;
  external_directory: PermissionDecision;
  doom_loop: PermissionDecision;
}

export interface VibeSpaceGatewayPolicy {
  projectRoot: string;
  projectGlob: string;
  mode: InteractionMode;
  access: AccessLevel;
  mutationAuthority: MutationAuthority;
  terminalAuthority: TerminalAuthority;
  allowRead: boolean;
  allowWrite: boolean;
  allowTerminal: boolean;
  allowGitWrite: boolean;
  allowBrowserMutation: boolean;
  allowDelete: boolean;
  allowSubagents: boolean;
  /**
   * Run-scoped eligibility only. The Tool Gateway must still prove that the
   * action belongs to the current run, workspace grant and authority class.
   */
  approveAllForRun: boolean;
  autoApproveExactRequestedActions: boolean;
  autoApproveAutonomousActions: boolean;
  planArtifactGlobs: readonly string[];
  hardDenySecrets: true;
  hardDenyExternalDirectory: true;
  hardDenyPrivilegeElevation: true;
  hardDenyProductionMutation: true;
}

export interface EffectivePermissionProfile {
  openCode: OpenCodePermissionProfile;
  gateway: VibeSpaceGatewayPolicy;
}

const SENSITIVE_READ_DENIES = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.git-credentials',
  '**/.netrc',
  '**/cookies.sqlite',
  '**/Login Data',
  '**/Local State',
  '**/credentials.json',
  '**/service-account*.json',
]);

function normalizeProjectRoot(projectRoot: string): string {
  const normalized = projectRoot.trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (
    !normalized
    || normalized.length > 4_096
    || normalized.includes('\0')
    || /[\r\n]/u.test(normalized)
  ) {
    throw new Error('A valid non-empty project root is required.');
  }
  return normalized;
}

function agentDecision(approveAllForRun: boolean): PermissionDecision {
  return approveAllForRun ? 'allow' : 'ask';
}

function mutationAuthorityFor(
  mode: InteractionMode,
  access: AccessLevel,
): MutationAuthority {
  if (access === 'read-only') return 'none';
  if (mode === 'ask') return 'exact-request';
  if (mode === 'plan') return 'plan-artifacts';
  return 'autonomous';
}

function terminalAuthorityFor(
  mode: InteractionMode,
  access: AccessLevel,
): TerminalAuthority {
  if (access !== 'full') return 'none';
  if (mode === 'ask') return 'exact-request';
  if (mode === 'plan') return 'inspection-only';
  return 'autonomous';
}

function editDecisionFor(
  authority: MutationAuthority,
  approveAllForRun: boolean,
): PermissionDecision {
  if (authority === 'none') return 'deny';
  // Ask/Plan require request-aware validation in the outer VibeSpace gateway;
  // keeping OpenCode at `ask` ensures an arbitrary model expansion cannot turn
  // a run-scoped approval into blanket write authority.
  if (authority === 'exact-request' || authority === 'plan-artifacts') return 'ask';
  return agentDecision(approveAllForRun);
}

function bashDecisionFor(
  authority: TerminalAuthority,
  approveAllForRun: boolean,
): PermissionDecision {
  if (authority === 'none') return 'deny';
  if (authority === 'exact-request' || authority === 'inspection-only') return 'ask';
  return agentDecision(approveAllForRun);
}

/**
 * Translate VibeSpace's orthogonal mode/access controls into OpenCode's
 * allow/ask/deny model while keeping VibeSpace as the outer, request-aware
 * authority. Approve All removes repeated prompts only for eligible actions in
 * the exact current run; it can never override explicit hard denies.
 */
export function buildEffectivePermissionProfile(
  input: Readonly<PermissionProfileInput>,
): EffectivePermissionProfile {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const projectGlob = `${projectRoot}/**`;
  const mutationAuthority = mutationAuthorityFor(input.mode, input.access);
  const terminalAuthority = terminalAuthorityFor(input.mode, input.access);
  const agent = input.mode === 'agent';
  const canWrite = mutationAuthority !== 'none';
  const canUseTerminal = terminalAuthority !== 'none';
  const autonomous = mutationAuthority === 'autonomous';
  const autonomousFull = terminalAuthority === 'autonomous';

  const readRules: Record<string, PermissionDecision> = {
    '*': 'deny',
    [projectGlob]: 'allow',
  };
  for (const pattern of SENSITIVE_READ_DENIES) readRules[pattern] = 'deny';

  const editDecision = editDecisionFor(mutationAuthority, input.approveAllForRun);
  const bashDecision = bashDecisionFor(terminalAuthority, input.approveAllForRun);
  const planArtifactGlobs = Object.freeze([
    `${projectRoot}/.vibespace/plans/**`,
    `${projectRoot}/docs/plans/**`,
    `${projectRoot}/plans/**`,
  ]);

  return {
    openCode: {
      read: Object.freeze(readRules),
      edit: Object.freeze({
        '*': 'deny',
        [projectGlob]: editDecision,
      }),
      bash: bashDecision,
      task: agent ? agentDecision(input.approveAllForRun) : 'deny',
      // Skills and web access are non-mutating by themselves. Their resulting
      // tool calls remain subject to the gateway and access profile.
      skill: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      external_directory: 'deny',
      doom_loop: 'deny',
    },
    gateway: {
      projectRoot,
      projectGlob,
      mode: input.mode,
      access: input.access,
      mutationAuthority,
      terminalAuthority,
      allowRead: true,
      allowWrite: canWrite,
      allowTerminal: canUseTerminal,
      allowGitWrite: input.access === 'full' && (input.mode === 'ask' || autonomousFull),
      allowBrowserMutation: input.access === 'full' && (input.mode === 'ask' || autonomousFull),
      allowDelete: autonomousFull,
      allowSubagents: agent,
      approveAllForRun: input.approveAllForRun,
      autoApproveExactRequestedActions:
        input.approveAllForRun && mutationAuthority === 'exact-request',
      autoApproveAutonomousActions:
        input.approveAllForRun && autonomous,
      planArtifactGlobs,
      hardDenySecrets: true,
      hardDenyExternalDirectory: true,
      hardDenyPrivilegeElevation: true,
      hardDenyProductionMutation: true,
    },
  };
}
