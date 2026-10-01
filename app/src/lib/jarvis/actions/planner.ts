import type { ActionResult, ActionRunContext } from '@/lib/actions/types';
import type { JarvisActionDefinition } from './catalog';

export type JarvisPlanStatus =
  | 'pending'
  | 'waiting-for-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JarvisPlanStep {
  id: string;
  action: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: ActionResult;
  verification: {
    status: 'pending' | 'verified' | 'failed' | 'unknown';
    evidence?: string;
  };
}

export interface JarvisExecutionPlan {
  id: string;
  goal: string;
  idempotencyKey: string;
  status: JarvisPlanStatus;
  steps: JarvisPlanStep[];
  createdAt: string;
  updatedAt: string;
}

export interface JarvisPlanReview {
  requiresApproval: boolean;
  approvalStepIds: string[];
  reasons: string[];
}

function newId(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function definitionMap(
  catalog: readonly JarvisActionDefinition[],
): Map<string, JarvisActionDefinition> {
  return new Map(catalog.map((definition) => [definition.id, definition]));
}

function validateInput(definition: JarvisActionDefinition, input: Record<string, unknown>): void {
  const properties = definition.inputSchema.properties ?? {};
  for (const required of definition.inputSchema.required ?? []) {
    if (input[required] === undefined || input[required] === null || input[required] === '') {
      throw new Error(`${definition.id}: missing required input "${required}".`);
    }
  }
  if (definition.inputSchema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) throw new Error(`${definition.id}: unknown input "${key}".`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const schema = properties[key];
    if (!schema || value === undefined || value === null) continue;
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`${definition.id}: input "${key}" must be a number.`);
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`${definition.id}: input "${key}" must be a boolean.`);
    }
    if (schema.type === 'string' && typeof value !== 'string') {
      throw new Error(`${definition.id}: input "${key}" must be a string.`);
    }
    if (schema.enum && !schema.enum.includes(String(value))) {
      throw new Error(`${definition.id}: input "${key}" must be one of ${schema.enum.join(', ')}.`);
    }
  }
}

export function createJarvisPlan(input: {
  goal: string;
  requestedSteps: Array<{ action: string; input: Record<string, unknown> }>;
  catalog: readonly JarvisActionDefinition[];
  idempotencyKey?: string;
  now?: Date;
}): JarvisExecutionPlan {
  const definitions = definitionMap(input.catalog);
  if (!input.goal.trim()) throw new Error('A Jarvis plan goal is required.');
  if (input.requestedSteps.length === 0)
    throw new Error('A Jarvis plan requires at least one step.');
  if (input.requestedSteps.length > 24)
    throw new Error('A Jarvis plan may contain at most 24 steps.');

  const now = (input.now ?? new Date()).toISOString();
  const planId = newId('jarvis-plan');
  const steps = input.requestedSteps.map((requested, index): JarvisPlanStep => {
    const definition = definitions.get(requested.action);
    if (!definition) throw new Error(`Action "${requested.action}" is not registered.`);
    validateInput(definition, requested.input);
    return {
      id: `${planId}-step-${index + 1}`,
      action: definition.id,
      input: structuredClone(requested.input),
      status: 'pending',
      verification: { status: 'pending' },
    };
  });
  return {
    id: planId,
    goal: input.goal.trim(),
    idempotencyKey: input.idempotencyKey?.trim() || planId,
    status: 'pending',
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function reviewJarvisPlan(
  plan: JarvisExecutionPlan,
  catalog: readonly JarvisActionDefinition[],
  permissions: { previouslyApproved: string[] },
): JarvisPlanReview {
  const definitions = definitionMap(catalog);
  const approved = new Set(permissions.previouslyApproved);
  const approvalStepIds: string[] = [];
  const reasons: string[] = [];
  for (const step of plan.steps) {
    const definition = definitions.get(step.action);
    if (!definition) {
      approvalStepIds.push(step.id);
      reasons.push(`${step.action} is no longer registered.`);
      continue;
    }
    const needsApproval =
      definition.approval === 'always' ||
      definition.approval === 'depends-on-input' ||
      (definition.approval === 'first-time' && !approved.has(definition.id));
    if (!needsApproval) continue;
    approvalStepIds.push(step.id);
    reasons.push(
      `${definition.title}: ${definition.risk} action requires ${definition.approval} approval.`,
    );
  }
  return {
    requiresApproval: approvalStepIds.length > 0,
    approvalStepIds,
    reasons,
  };
}

const completedExecutions = new Map<string, JarvisExecutionPlan>();

function abortError(): DOMException {
  return new DOMException('Jarvis task cancelled.', 'AbortError');
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let timeoutFailure: Error | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timeoutFailure = new Error(`Action timed out after ${timeoutMs} ms.`);
      controller.abort();
      reject(timeoutFailure);
    }, timeoutMs);
    if (signal) {
      abortHandler = () => {
        controller.abort();
        reject(abortError());
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  try {
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise]);
    } catch (error) {
      // Aborting a compliant executor can synchronously enqueue its AbortError
      // before the timeout promise rejects. The timeout remains the initiating
      // terminal cause even though cancellation is signalled first.
      if (timeoutFailure) throw timeoutFailure;
      throw error;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

export async function executeJarvisPlan(
  plan: JarvisExecutionPlan,
  catalog: readonly JarvisActionDefinition[],
  options: {
    executeApprovedStep: (
      step: Readonly<JarvisPlanStep>,
      signal: AbortSignal,
    ) => Promise<ActionResult>;
    signal?: AbortSignal;
    timeoutMs?: number;
    approved?: boolean;
    previouslyApproved?: string[];
    context?: ActionRunContext;
    onProgress?: (plan: JarvisExecutionPlan) => void;
  },
): Promise<JarvisExecutionPlan> {
  const cached = completedExecutions.get(plan.idempotencyKey);
  if (cached) return cached;

  const review = reviewJarvisPlan(plan, catalog, {
    previouslyApproved: options.previouslyApproved ?? [],
  });
  if (review.requiresApproval && !options.approved) {
    const waiting = {
      ...plan,
      status: 'waiting-for-approval' as const,
      updatedAt: new Date().toISOString(),
    };
    options.onProgress?.(waiting);
    return waiting;
  }

  const definitions = definitionMap(catalog);
  const next: JarvisExecutionPlan = structuredClone(plan);
  next.status = 'running';
  next.updatedAt = new Date().toISOString();
  options.onProgress?.(structuredClone(next));

  for (const step of next.steps) {
    if (options.signal?.aborted) {
      step.status = 'cancelled';
      next.status = 'cancelled';
      next.updatedAt = new Date().toISOString();
      options.onProgress?.(structuredClone(next));
      return next;
    }
    const definition = definitions.get(step.action);
    if (!definition) {
      step.status = 'failed';
      step.verification = { status: 'failed', evidence: 'Action handler is no longer registered.' };
      next.status = 'failed';
      break;
    }
    step.status = 'running';
    options.onProgress?.(structuredClone(next));
    try {
      const result = await withTimeout(
        (executionSignal) =>
          options.executeApprovedStep(Object.freeze(structuredClone(step)), executionSignal),
        options.timeoutMs ?? 30_000,
        options.signal,
      );
      step.result = result;
      if (!result.ok) {
        step.status = 'failed';
        step.verification = { status: 'failed', evidence: result.error };
        next.status = 'failed';
        break;
      }
      const evidence = result.summary?.trim();
      if (!evidence) {
        step.status = 'failed';
        step.verification = {
          status: 'unknown',
          evidence: 'Handler returned success without verifiable evidence.',
        };
        next.status = 'failed';
        break;
      }
      step.status = 'completed';
      step.verification = { status: 'verified', evidence };
    } catch (error) {
      const cancelled = (error as Error)?.name === 'AbortError';
      step.status = cancelled ? 'cancelled' : 'failed';
      step.verification = {
        status: 'failed',
        evidence: error instanceof Error ? error.message : String(error),
      };
      next.status = cancelled ? 'cancelled' : 'failed';
      break;
    } finally {
      next.updatedAt = new Date().toISOString();
      options.onProgress?.(structuredClone(next));
    }
  }

  if (next.status === 'running') next.status = 'completed';
  next.updatedAt = new Date().toISOString();
  if (next.status === 'completed')
    completedExecutions.set(next.idempotencyKey, structuredClone(next));
  options.onProgress?.(structuredClone(next));
  return next;
}

export function resetJarvisPlanIdempotencyForTests(): void {
  completedExecutions.clear();
}
