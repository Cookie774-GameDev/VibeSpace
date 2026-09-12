import type { JarvisIssuedActionExecution } from './approvalEngine';
import type {
  NativeCapabilityApproval,
  NativeCapabilityKind,
  NativeCapabilityRisk,
} from './nativeCapabilityBroker';

export type FileCapabilityOperation = 'file.read' | 'file.list' | 'file.write' | 'file.delete';
export type TerminalCapabilityOperation =
  | 'terminal.spawn'
  | 'terminal.write'
  | 'terminal.read'
  | 'terminal.kill';
export type GitCapabilityOperation =
  | 'git.status'
  | 'git.diff'
  | 'git.worktree'
  | 'git.index'
  | 'git.commit'
  | 'git.fetch'
  | 'git.push'
  | 'git.ref';
export type BrowserCapabilityOperation =
  | 'browser.snapshot'
  | 'browser.screenshot'
  | 'browser.navigate'
  | 'browser.click'
  | 'browser.type'
  | 'browser.download';
export type McpCapabilityOperation = 'mcp.listTools' | 'mcp.invoke' | 'mcp.disconnect';

export type NativeCapabilityOperation =
  | FileCapabilityOperation
  | TerminalCapabilityOperation
  | GitCapabilityOperation
  | BrowserCapabilityOperation
  | McpCapabilityOperation;

export type NativeCapabilityEvidenceExpectation = 'canonical_result' | 'canonical_artifact';
export type NativeCapabilityCancellationExpectation = 'required' | 'not_applicable';

export type NativeCapabilityOperationDescriptor = Readonly<{
  name: NativeCapabilityOperation;
  risk: NativeCapabilityRisk;
  approval: NativeCapabilityApproval;
  producerKind: JarvisIssuedActionExecution['producerKind'];
  evidence: NativeCapabilityEvidenceExpectation;
  cancellation: NativeCapabilityCancellationExpectation;
}>;

export type NativeCapabilityAdapterDescriptorV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  version: number;
  kind: NativeCapabilityKind;
  operations: readonly NativeCapabilityOperationDescriptor[];
}>;

export type NativeCapabilityAdapterDescriptorInput = Readonly<{
  schemaVersion: 1;
  id: string;
  version: number;
  kind: NativeCapabilityKind;
  operations: readonly Readonly<{
    name: string;
    risk: NativeCapabilityRisk;
    approval: NativeCapabilityApproval;
    producerKind: JarvisIssuedActionExecution['producerKind'];
    evidence: NativeCapabilityEvidenceExpectation;
    cancellation: NativeCapabilityCancellationExpectation;
  }>[];
}>;

const OPERATIONS: Readonly<Record<NativeCapabilityKind, ReadonlySet<string>>> = Object.freeze({
  file: new Set<FileCapabilityOperation>(['file.read', 'file.list', 'file.write', 'file.delete']),
  terminal: new Set<TerminalCapabilityOperation>([
    'terminal.spawn',
    'terminal.write',
    'terminal.read',
    'terminal.kill',
  ]),
  git: new Set<GitCapabilityOperation>([
    'git.status',
    'git.diff',
    'git.worktree',
    'git.index',
    'git.commit',
    'git.fetch',
    'git.push',
    'git.ref',
  ]),
  browser: new Set<BrowserCapabilityOperation>([
    'browser.snapshot',
    'browser.screenshot',
    'browser.navigate',
    'browser.click',
    'browser.type',
    'browser.download',
  ]),
  mcp: new Set<McpCapabilityOperation>(['mcp.listTools', 'mcp.invoke', 'mcp.disconnect']),
});

const PRODUCERS: Readonly<
  Record<NativeCapabilityKind, JarvisIssuedActionExecution['producerKind']>
> = Object.freeze({
  file: 'file_action',
  terminal: 'terminal',
  git: 'terminal',
  browser: 'action',
  mcp: 'mcp',
});
const RISKS = new Set<NativeCapabilityRisk>([
  'read-only',
  'safe-write',
  'external-side-effect',
  'destructive',
  'credential-sensitive',
]);
const APPROVALS = new Set<NativeCapabilityApproval>([
  'never',
  'first-time',
  'always',
  'depends-on-input',
]);
const EVIDENCE = new Set<NativeCapabilityEvidenceExpectation>([
  'canonical_result',
  'canonical_artifact',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

export function createNativeCapabilityAdapterDescriptor(
  input: NativeCapabilityAdapterDescriptorInput,
): NativeCapabilityAdapterDescriptorV1 {
  if (
    input.schemaVersion !== 1 ||
    !SAFE_ID.test(input.id) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !OPERATIONS[input.kind] ||
    input.operations.length === 0
  ) {
    throw new Error('Invalid native capability adapter descriptor.');
  }
  const names = new Set<string>();
  const operations = input.operations.map((operation): NativeCapabilityOperationDescriptor => {
    if (
      !OPERATIONS[input.kind].has(operation.name) ||
      names.has(operation.name) ||
      !RISKS.has(operation.risk) ||
      !APPROVALS.has(operation.approval) ||
      operation.producerKind !== PRODUCERS[input.kind] ||
      !EVIDENCE.has(operation.evidence) ||
      operation.cancellation !== 'required'
    ) {
      throw new Error('Invalid native capability operation descriptor.');
    }
    names.add(operation.name);
    return Object.freeze({
      ...operation,
      name: operation.name as NativeCapabilityOperation,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    kind: input.kind,
    operations: Object.freeze(operations),
  });
}
