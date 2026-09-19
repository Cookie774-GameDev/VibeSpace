import {
  isTerminalTurnStatus,
  type CanonicalTurnState,
  type TurnEvent,
  type TurnPreviewSegment,
  type TurnPublicSnapshot,
} from './turnTypes';

const EMPTY_SEGMENTS: readonly TurnPreviewSegment[] = Object.freeze([]);

function sameSegment(left: TurnPreviewSegment, right: TurnPreviewSegment): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === 'text' && right.kind === 'text') return left.text === right.text;
  return (
    left.kind === 'tool' &&
    right.kind === 'tool' &&
    left.name === right.name &&
    left.status === right.status &&
    left.fileLabel === right.fileLabel &&
    left.details === right.details
  );
}

function detachSegment(
  segment: TurnPreviewSegment,
  previous?: TurnPreviewSegment,
): TurnPreviewSegment {
  if (previous && sameSegment(previous, segment)) return previous;
  return Object.isFrozen(segment)
    ? segment
    : (Object.freeze({ ...segment }) as TurnPreviewSegment);
}

function detachSnapshot(
  snapshot: TurnPublicSnapshot,
  previous?: Readonly<TurnPublicSnapshot>,
): Readonly<TurnPublicSnapshot> {
  const priorByKey = new Map<string, TurnPreviewSegment>();
  for (const segment of previous?.segments ?? EMPTY_SEGMENTS) {
    priorByKey.set(segment.kind + ':' + segment.id, segment);
  }
  const segments = snapshot.segments.length
    ? Object.freeze(
        snapshot.segments.map((segment) =>
          detachSegment(segment, priorByKey.get(segment.kind + ':' + segment.id)),
        ),
      )
    : EMPTY_SEGMENTS;
  return Object.freeze({ ...snapshot, segments });
}

function terminalizeSegments(
  segments: readonly TurnPreviewSegment[],
): readonly TurnPreviewSegment[] {
  let changed = false;
  const next = segments.map((segment) => {
    if (segment.kind !== 'tool' || segment.status !== 'started') return segment;
    changed = true;
    return Object.freeze({ ...segment, status: 'interrupted' as const });
  });
  return changed ? Object.freeze(next) : segments;
}

function terminalState(
  state: CanonicalTurnState,
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
  at: number,
  additions: Partial<Pick<CanonicalTurnState, 'error' | 'errorCode'>> = {},
): CanonicalTurnState {
  if (isTerminalTurnStatus(state.status)) return state;
  return Object.freeze({
    ...state,
    ...additions,
    revision: state.revision + 1,
    status,
    terminalAt: at,
    reasoning: '',
    public: Object.freeze({
      ...state.public,
      segments: terminalizeSegments(state.public.segments),
    }),
  });
}

export function reduceTurn(
  state: CanonicalTurnState | undefined,
  event: TurnEvent,
): CanonicalTurnState {
  if (event.type === 'turn.accepted') {
    if (state) {
      if (
        state.identity.accountId === event.identity.accountId &&
        state.identity.runId === event.identity.runId &&
        state.identity.requestId === event.identity.requestId
      ) {
        return state;
      }
      throw new Error('turn_identity_rebind_rejected');
    }
    return Object.freeze({
      identity: Object.freeze({ ...event.identity }),
      revision: 1,
      status: 'preparing',
      reasoning: '',
      public: Object.freeze({
        text: '',
        segments: EMPTY_SEGMENTS,
        updatedAt: event.at,
      }),
      acceptedAt: event.at,
      ...(event.cancellationKey ? { cancellationKey: event.cancellationKey } : {}),
    });
  }

  if (!state) throw new Error('turn_event_before_acceptance');
  // Terminal authority is immutable, but clearing an already-rendered public
  // preview is presentation cleanup and must not erase that terminal status.
  if (isTerminalTurnStatus(state.status) && event.type !== 'public.cleared') return state;

  switch (event.type) {
    case 'turn.running':
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        status: 'running',
        ...(event.cancellationKey ? { cancellationKey: event.cancellationKey } : {}),
      });
    case 'turn.failed':
      return terminalState(
        state,
        'failed',
        event.at,
        event.errorCode ? { errorCode: event.errorCode } : {},
      );
    case 'provider.bound':
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        provider: Object.freeze({ ...event.provider }),
        firstProviderEventAt: state.firstProviderEventAt ?? event.at,
      });
    case 'turn.context_planned':
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        contextPlan: Object.freeze({
          ...event.plan,
          ...(event.plan.activePaths
            ? { activePaths: Object.freeze([...event.plan.activePaths]) }
            : {}),
          ...(event.plan.exactIdentifiers
            ? { exactIdentifiers: Object.freeze([...event.plan.exactIdentifiers]) }
            : {}),
        }),
      });
    case 'reasoning.delta': {
      const reasoning = event.mode === 'replace' ? event.text : state.reasoning + event.text;
      if (reasoning === state.reasoning) return state;
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        reasoning,
        firstProviderEventAt: state.firstProviderEventAt ?? event.at,
      });
    }
    case 'public.snapshot': {
      const nextPublic = detachSnapshot(event.snapshot, state.public);
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        status: state.status === 'preparing' ? 'running' : state.status,
        public: nextPublic,
        firstProviderEventAt: state.firstProviderEventAt ?? event.at,
        firstPublicTextAt:
          state.firstPublicTextAt ??
          (event.snapshot.text ||
          event.snapshot.segments.some((segment) => segment.kind === 'text')
            ? event.at
            : undefined),
      });
    }
    case 'public.cleared':
      if (!state.public.text && state.public.segments.length === 0) return state;
      return Object.freeze({
        ...state,
        revision: state.revision + 1,
        public: Object.freeze({
          ...state.public,
          text: '',
          segments: EMPTY_SEGMENTS,
          updatedAt: event.at,
        }),
      });
    case 'provider.error':
      return terminalState(state, 'failed', event.at, {
        error: Object.freeze({ ...event.error }),
        ...(event.error.code ? { errorCode: event.error.code } : {}),
      });
    case 'turn.completed':
      return terminalState(state, 'completed', event.at);
    case 'turn.cancelled':
      return terminalState(state, 'cancelled', event.at);
    case 'turn.interrupted':
      return terminalState(state, 'interrupted', event.at, {
        ...(event.reason ? { errorCode: event.reason } : {}),
      });
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
