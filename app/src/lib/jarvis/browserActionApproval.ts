import {
  evaluateUntrustedContent,
  type UntrustedContentReceipt,
} from './untrustedContentPolicy';

export type BrowserActionKind =
  | 'read'
  | 'navigate'
  | 'type'
  | 'click'
  | 'download'
  | 'upload'
  | 'submit'
  | 'credential_entry'
  | 'payment'
  | 'delete'
  | 'external_message';

export type BrowserActionClassification = Readonly<{
  risk: 'read_navigation' | 'consequential' | 'high_risk';
  approval: 'none' | 'explicit';
}>;

export type BrowserActionRequest = Readonly<{
  requestId: string;
  accountId: string;
  projectId: string;
  sessionId: string;
  action: BrowserActionKind;
  actionHash: `sha256:${string}`;
}>;

export type BrowserActionApprovalGrant = Readonly<
  BrowserActionRequest & {
    schemaVersion: 1;
    grantId: string;
    approvalEvidenceRef: `jlive_${string}`;
    issuedAt: number;
    expiresAt: number;
  }
>;

export type BrowserActionAuthorization = Readonly<
  BrowserActionRequest & {
    classification: BrowserActionClassification;
    authority: 'scoped';
    grantId?: string;
  }
>;

export interface BrowserActionApprovalAuthority {
  verifyExplicitApproval(input: {
    request: BrowserActionRequest;
    grantId: string;
    approvalEvidenceRef: `jlive_${string}`;
    issuedAt: number;
    expiresAt: number;
  }): boolean;
}

export interface BrowserActionApprovalContract {
  classify(action: BrowserActionKind): BrowserActionClassification;
  issue(input: {
    request: BrowserActionRequest;
    grantId: string;
    approvalEvidenceRef: `jlive_${string}`;
    issuedAt: number;
    expiresAt: number;
  }): BrowserActionApprovalGrant;
  authorize(input: {
    request: BrowserActionRequest;
    grant?: BrowserActionApprovalGrant;
    now: number;
  }): BrowserActionAuthorization;
  evaluateReturnedContent(input: {
    source: 'browser_dom' | 'mcp';
    content: string;
  }): Promise<UntrustedContentReceipt>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const ACTION_HASH = /^sha256:[a-f0-9]{64}$/iu;
const LIVE_REF = /^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const ACTIONS = new Set<BrowserActionKind>([
  'read',
  'navigate',
  'type',
  'click',
  'download',
  'upload',
  'submit',
  'credential_entry',
  'payment',
  'delete',
  'external_message',
]);

function validateRequest(request: BrowserActionRequest): void {
  if (
    !SAFE_ID.test(request.requestId) ||
    !SAFE_ID.test(request.accountId) ||
    !SAFE_ID.test(request.projectId) ||
    !SAFE_ID.test(request.sessionId) ||
    !ACTIONS.has(request.action) ||
    !ACTION_HASH.test(request.actionHash)
  ) {
    throw new Error('Invalid browser action request.');
  }
}

function sameRequest(
  left: BrowserActionRequest,
  right: BrowserActionRequest,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.action === right.action &&
    left.actionHash.toLowerCase() === right.actionHash.toLowerCase()
  );
}

export function classifyBrowserAction(
  action: BrowserActionKind,
): BrowserActionClassification {
  if (action === 'read' || action === 'navigate') {
    return Object.freeze({ risk: 'read_navigation', approval: 'none' });
  }
  if (action === 'type' || action === 'click' || action === 'download') {
    return Object.freeze({ risk: 'consequential', approval: 'explicit' });
  }
  if (ACTIONS.has(action)) {
    return Object.freeze({ risk: 'high_risk', approval: 'explicit' });
  }
  throw new Error('Unknown browser action.');
}

export function createBrowserActionApprovalContract(
  authority: BrowserActionApprovalAuthority,
): BrowserActionApprovalContract {
  const issued = new WeakSet<object>();
  const consumed = new WeakSet<object>();

  return Object.freeze<BrowserActionApprovalContract>({
    classify: classifyBrowserAction,

    issue({ request, grantId, approvalEvidenceRef, issuedAt, expiresAt }) {
      validateRequest(request);
      if (
        classifyBrowserAction(request.action).approval !== 'explicit' ||
        !SAFE_ID.test(grantId) ||
        !LIVE_REF.test(approvalEvidenceRef) ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= issuedAt ||
        !authority.verifyExplicitApproval({
          request: Object.freeze({ ...request }),
          grantId,
          approvalEvidenceRef,
          issuedAt,
          expiresAt,
        })
      ) {
        throw new Error('Invalid explicit browser approval.');
      }
      const grant = Object.freeze({
        schemaVersion: 1 as const,
        ...request,
        actionHash: request.actionHash.toLowerCase() as `sha256:${string}`,
        grantId,
        approvalEvidenceRef,
        issuedAt,
        expiresAt,
      });
      issued.add(grant);
      return grant;
    },

    authorize({ request, grant, now }) {
      validateRequest(request);
      if (!Number.isFinite(now)) throw new Error('Invalid browser authorization time.');
      const classification = classifyBrowserAction(request.action);
      if (classification.approval === 'explicit') {
        if (
          !grant ||
          !issued.has(grant) ||
          consumed.has(grant) ||
          !sameRequest(request, grant) ||
          now < grant.issuedAt ||
          now >= grant.expiresAt
        ) {
          throw new Error('Matching unused browser approval is required.');
        }
        consumed.add(grant);
      } else if (grant !== undefined) {
        throw new Error('Approval grants cannot be broadened to approval-free actions.');
      }
      return Object.freeze({
        ...request,
        actionHash: request.actionHash.toLowerCase() as `sha256:${string}`,
        classification,
        authority: 'scoped' as const,
        ...(grant === undefined ? {} : { grantId: grant.grantId }),
      });
    },

    evaluateReturnedContent({ source, content }) {
      return evaluateUntrustedContent({ source, content });
    },
  });
}
