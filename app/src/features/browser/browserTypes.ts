import type { Agent } from '@/types/agent';
import type { JarvisApproval } from '@/lib/jarvis/contracts';

export type BrowserControlMode =
  | 'user_only'
  | 'ask_every_action'
  | 'allow_safe_session'
  | 'agent_controlled';

export type BrowserJsonPrimitive = string | number | boolean | null;
export type BrowserJsonValue = BrowserJsonPrimitive | BrowserJsonValue[] | BrowserJsonObject;
export type BrowserJsonObject = {
  [key: string]: BrowserJsonValue;
};

export type BrowserActionRisk = JarvisApproval['risk'];

export type BrowserActionRequester = {
  kind: 'agent';
  agent: Pick<Agent, 'id' | 'slug' | 'builtin'>;
  runId?: string;
};

export type BrowserActionTarget = {
  currentUrl: string;
  requestedUrl?: string;
  selector?: string;
  coordinates?: { x: number; y: number };
};

export type BrowserReviewedActionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'expired'
  | 'unavailable';

export type BrowserReviewedAction = {
  id: string;
  accountId: string;
  requester: BrowserActionRequester;
  kind: string;
  actionVersion: 1;
  origin: string;
  tabId: string;
  frameId?: string;
  target: BrowserActionTarget;
  parameters: BrowserJsonObject;
  parametersHash: string;
  reviewedHash: string;
  expectedEffect: string;
  risk: BrowserActionRisk;
  safeSummary: string;
  status: BrowserReviewedActionStatus;
  requestedAt: number;
  expiresAt: number;
  result?: string;
};

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  pinned: boolean;
  muted: boolean;
  controlMode: BrowserControlMode;
  lastError?: string;
}

export interface BrowserConsoleEntry {
  id: string;
  level: 'log' | 'warn' | 'error' | 'info';
  text: string;
  ts: number;
}

export interface BrowserRuntimeInfo {
  running: boolean;
  executable?: string | null;
  profile_dir?: string | null;
  cdp_port?: number | null;
  cdp_ws_url?: string | null;
  session_id?: string | null;
  last_error?: string | null;
  installations?: Array<{ name: string; path: string; kind: string }>;
}
