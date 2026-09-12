import type { BrowserActionAuthorization } from './browserActionApproval';
import type {
  NativeCapabilityAdapter,
  NativeCapabilityRequest,
} from './nativeCapabilityBroker';
import type {
  PlaywrightBrowserAction,
  PlaywrightBrowserReceipt,
  PlaywrightBrowserScope,
  PlaywrightBrowserWorker,
} from './playwrightBrowserWorker';

export type BrowserGoalPlaywrightEnvelope = Readonly<{
  accountId: string;
  projectId: string;
  runId: string;
  workspaceRoot: string;
  scope: PlaywrightBrowserScope;
  action: PlaywrightBrowserAction;
  authorization: BrowserActionAuthorization;
}>;

export interface BrowserGoalPlaywrightCatalog {
  resolve(request: Readonly<NativeCapabilityRequest>): Promise<BrowserGoalPlaywrightEnvelope | null>;
}

export interface BrowserGoalPlaywrightAdapter {
  nativeAdapter: NativeCapabilityAdapter;
  receipt(resultRef: string): PlaywrightBrowserReceipt | undefined;
}

function expectedOperation(action: PlaywrightBrowserAction): string {
  if (action.name === 'observe') return 'browser.snapshot';
  if (action.name === 'screenshot') return 'browser.screenshot';
  if (
    action.name === 'navigate' ||
    action.name === 'open_tab' ||
    action.name === 'switch_tab' ||
    action.name === 'close_tab'
  ) {
    return 'browser.navigate';
  }
  if (
    action.name === 'fill' ||
    action.name === 'select' ||
    action.name === 'check' ||
    action.name === 'upload'
  ) {
    return 'browser.type';
  }
  if (action.name === 'download') return 'browser.download';
  return 'browser.click';
}

export function createBrowserGoalPlaywrightAdapter(input: {
  id?: string;
  worker: PlaywrightBrowserWorker;
  catalog: BrowserGoalPlaywrightCatalog;
  maximumRetainedReceipts?: number;
}): BrowserGoalPlaywrightAdapter {
  const maximum = input.maximumRetainedReceipts ?? 500;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(input.id ?? 'browser.playwright') ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 5_000
  ) {
    throw new Error('Invalid Browser Goal Playwright adapter configuration.');
  }
  const receipts = new Map<string, PlaywrightBrowserReceipt>();
  const nativeAdapter = Object.freeze<NativeCapabilityAdapter>({
    id: input.id ?? 'browser.playwright',
    version: 1,
    kind: 'browser',
    operations: Object.freeze([
      'browser.snapshot',
      'browser.screenshot',
      'browser.navigate',
      'browser.click',
      'browser.type',
      'browser.download',
    ]),
    risk: 'external-side-effect',
    approval: 'depends-on-input',
    producerKinds: Object.freeze(['action'] as const),
    async execute({ request, signal }) {
      const envelope = await input.catalog.resolve(request);
      if (
        !envelope ||
        envelope.accountId !== request.accountId ||
        envelope.runId !== request.runId ||
        envelope.workspaceRoot !== request.workspaceRoot ||
        envelope.scope.accountId !== request.accountId ||
        envelope.scope.projectId !== envelope.projectId ||
        envelope.scope.requestId !== request.requestId ||
        envelope.scope.actionHash !== request.parameterHash ||
        expectedOperation(envelope.action) !== request.operation ||
        signal.aborted
      ) {
        throw new Error('Browser Goal action does not match its native request.');
      }
      const receipt = await input.worker.execute({
        scope: envelope.scope,
        action: envelope.action,
        authorization: envelope.authorization,
        signal,
      });
      if (signal.aborted || receipt.actionHash !== request.parameterHash) {
        throw new Error('Browser Goal action was cancelled or returned mismatched evidence.');
      }
      if (receipts.has(receipt.resultRef)) {
        throw new Error('Browser Goal worker result reference was already retained.');
      }
      receipts.set(receipt.resultRef, receipt);
      while (receipts.size > maximum) {
        const oldest = receipts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        receipts.delete(oldest);
      }
      return { state: 'completed', resultRef: receipt.resultRef };
    },
  });
  return Object.freeze<BrowserGoalPlaywrightAdapter>({
    nativeAdapter,
    receipt(resultRef) {
      return receipts.get(resultRef);
    },
  });
}
