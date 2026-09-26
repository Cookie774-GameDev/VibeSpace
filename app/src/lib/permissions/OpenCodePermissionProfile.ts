export type InteractionMode = 'ask' | 'plan' | 'agent';
export type AccessLevel = 'read-only' | 'write' | 'full';
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type BashPermission = PermissionDecision | Readonly<Record<string, PermissionDecision>>;
/** Persistent Agent profile captured for one provider run. */
export type AgentApprovalMode = 'full' | 'review';
export type OpenCodeExecutionAgentId =
  | 'vibespace-readonly'
  | 'vibespace-write'
  | 'vibespace-write-auto'
  | 'vibespace-full'
  | 'vibespace-full-auto';

export type MutationAuthority = 'none' | 'exact-request' | 'plan-artifacts' | 'autonomous';

export type TerminalAuthority = 'none' | 'exact-request' | 'inspection-only' | 'autonomous';

export interface PermissionProfileInput {
  mode: InteractionMode;
  access: AccessLevel;
  approveAllForRun: boolean;
  /** Optional for legacy callers; runtime sends the persisted profile explicitly. */
  agentApprovalMode?: AgentApprovalMode;
  projectRoot: string;
}

export interface OpenCodePermissionProfile {
  read: Readonly<Record<string, PermissionDecision>>;
  edit: Readonly<Record<string, PermissionDecision>>;
  bash: BashPermission;
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
  openCodeAgent: OpenCodeExecutionAgentId;
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
    !normalized ||
    normalized.length > 4_096 ||
    normalized.includes('\0') ||
    /[\r\n]/u.test(normalized)
  ) {
    throw new Error('A valid non-empty project root is required.');
  }
  return normalized;
}

function agentDecision(approveAllForRun: boolean): PermissionDecision {
  return approveAllForRun ? 'allow' : 'ask';
}

function nativeApproveAllForRun(input: Readonly<PermissionProfileInput>): boolean {
  // The persistent review profile must retain native asks even if an older
  // caller still carries the transient approveAllForRun bit. Full is the only
  // profile that selects the native never/allow routine policy.
  if (input.agentApprovalMode === 'full') return true;
  if (input.agentApprovalMode === 'review') return false;
  return input.approveAllForRun;
}

function mutationAuthorityFor(mode: InteractionMode, access: AccessLevel): MutationAuthority {
  return mode === 'agent' && access !== 'read-only' ? 'autonomous' : 'none';
}

function terminalAuthorityFor(mode: InteractionMode, access: AccessLevel): TerminalAuthority {
  return mode === 'agent' && access === 'full' ? 'autonomous' : 'none';
}

function openCodeExecutionAgentFor(
  mode: InteractionMode,
  access: AccessLevel,
  approveAllForRun: boolean,
): OpenCodeExecutionAgentId {
  if (mode !== 'agent' || access === 'read-only') return 'vibespace-readonly';
  if (access === 'write') {
    return approveAllForRun ? 'vibespace-write-auto' : 'vibespace-write';
  }
  return approveAllForRun ? 'vibespace-full-auto' : 'vibespace-full';
}

function editDecisionFor(authority: MutationAuthority): PermissionDecision {
  if (authority === 'none') return 'deny';
  // Non-Agent paths never gain autonomous write authority, and paths outside
  // the selected project remain guarded by external_directory.
  if (authority === 'exact-request' || authority === 'plan-artifacts') return 'ask';
  // Agent write/full access scopes edits to the current project. Review mode
  // still asks before paths outside the project through external_directory.
  return 'allow';
}

const REVIEW_BASH_ASK_PATTERNS: Readonly<Record<string, PermissionDecision>> = Object.freeze({
  'rm *': 'ask',
  'rmdir *': 'ask',
  'del *': 'ask',
  'erase *': 'ask',
  'rd *': 'ask',
  'Remove-Item *': 'ask',
  'format *': 'ask',
  'diskpart *': 'ask',
  'sudo *': 'ask',
  'runas *': 'ask',
  'Start-Process *': 'ask',
  'git clean *': 'ask',
  'git reset *': 'ask',
  'git checkout -- *': 'ask',
  'git restore *': 'ask',
  'git push *': 'ask',
  'npm publish *': 'ask',
  'cargo publish *': 'ask',
  'gh repo delete *': 'ask',
});

function bashDecisionFor(authority: TerminalAuthority, approveAllForRun: boolean): BashPermission {
  if (authority === 'autonomous' && approveAllForRun) return 'allow';
  if (authority === 'autonomous') {
    // The OpenCode agent is already bound to this project's working directory.
    // Keep ordinary native CLI work prompt-free and ask on destructive,
    // privilege-changing, or externally publishing command patterns.
    return Object.freeze({ '*': 'allow', ...REVIEW_BASH_ASK_PATTERNS });
  }
  const defaultDecision = 'deny';
  // Use exact, argument-free commands for the native shell's low-risk
  // inspection path. Argument-bearing patterns can also match shell
  // redirection, so project reads with filters use OpenCode's read/grep tools.
  return Object.freeze({
    '*': defaultDecision,
    pwd: 'allow',
    ls: 'allow',
    'git status': 'allow',
    'git diff': 'allow',
    'git log': 'allow',
  });
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
  const nativeApproveAll = nativeApproveAllForRun(input);
  const mutationAuthority = mutationAuthorityFor(input.mode, input.access);
  const terminalAuthority = terminalAuthorityFor(input.mode, input.access);
  const agent = input.mode === 'agent';
  const nativeFullAccess =
    input.agentApprovalMode === 'full' && input.mode === 'agent' && input.access === 'full';
  const canWrite = mutationAuthority !== 'none';
  const canUseTerminal = terminalAuthority !== 'none';
  const autonomous = mutationAuthority === 'autonomous';
  const autonomousFull = terminalAuthority === 'autonomous';

  const readRules: Record<string, PermissionDecision> = {
    '*': nativeFullAccess ? 'allow' : 'deny',
    [projectGlob]: 'allow',
  };
  for (const pattern of SENSITIVE_READ_DENIES) readRules[pattern] = 'deny';

  const editDecision = editDecisionFor(mutationAuthority);
  const reviewAccess = input.mode === 'agent' && input.access !== 'read-only' && !nativeApproveAll;
  const bashDecision = bashDecisionFor(terminalAuthority, nativeApproveAll);
  const planArtifactGlobs = Object.freeze([
    `${projectRoot}/.vibespace/plans/**`,
    `${projectRoot}/docs/plans/**`,
    `${projectRoot}/plans/**`,
  ]);

  return {
    openCodeAgent: openCodeExecutionAgentFor(input.mode, input.access, nativeApproveAll),
    openCode: {
      read: Object.freeze(readRules),
      edit: Object.freeze({
        '*': nativeFullAccess ? 'allow' : 'deny',
        [projectGlob]: nativeFullAccess ? 'allow' : editDecision,
      }),
      bash: bashDecision,
      task: agent ? agentDecision(nativeApproveAll) : 'deny',
      // Skills and web access are non-mutating by themselves. Their resulting
      // tool calls remain subject to the gateway and access profile.
      skill: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      // The explicit Full profile opts into native unrestricted routing. The
      // outer gateway hard-deny fields below still govern VibeSpace tools.
      external_directory: nativeFullAccess ? 'allow' : 'ask',
      doom_loop: reviewAccess ? 'ask' : 'deny',
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
      allowGitWrite: input.access === 'full' && autonomousFull,
      allowBrowserMutation: input.access === 'full' && autonomousFull,
      allowDelete: autonomousFull,
      allowSubagents: agent,
      approveAllForRun: nativeApproveAll,
      autoApproveExactRequestedActions: nativeApproveAll && mutationAuthority === 'exact-request',
      autoApproveAutonomousActions: nativeApproveAll && autonomous,
      planArtifactGlobs,
      hardDenySecrets: true,
      hardDenyExternalDirectory: true,
      hardDenyPrivilegeElevation: true,
      hardDenyProductionMutation: true,
    },
  };
}
