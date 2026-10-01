import * as React from 'react';
import type { ChatActivityCategory, ChatActivityKind, ChatActivityStatus } from '../activity/types';
import './agent-motion.css';

export type AgentMotionKind =
  | 'glyph-current'
  | 'nine-dot-fold'
  | 'twin-loop'
  | 'cursor-forge'
  | 'breathing-brackets'
  | 'stack-shift'
  | 'code-shimmer';

export interface AgentMotionEvidence {
  status?: ChatActivityStatus;
  activityCategory?: ChatActivityCategory;
  activityKind?: ChatActivityKind;
  title?: string;
  detail?: string;
  filePath?: string;
}

const LIVE_STATUSES = new Set<ChatActivityStatus>(['pending', 'running']);

const CATEGORY_MOTION: Readonly<Record<ChatActivityCategory, AgentMotionKind>> = {
  thinking: 'cursor-forge',
  file: 'stack-shift',
  writing: 'code-shimmer',
  coordination: 'nine-dot-fold',
  context: 'twin-loop',
  learning: 'breathing-brackets',
  response: 'glyph-current',
};

const KIND_CATEGORY: Readonly<Record<ChatActivityKind, ChatActivityCategory>> = {
  diff: 'writing',
  file: 'file',
  url: 'context',
  subagent: 'coordination',
  tool: 'thinking',
  agent: 'thinking',
};

export function resolveAgentMotion(evidence: AgentMotionEvidence): AgentMotionKind | null {
  if (!evidence.status || !LIVE_STATUSES.has(evidence.status)) return null;
  const structuredCategory =
    evidence.activityCategory &&
    Object.prototype.hasOwnProperty.call(CATEGORY_MOTION, evidence.activityCategory)
      ? evidence.activityCategory
      : undefined;
  const structuredKind =
    evidence.activityKind &&
    Object.prototype.hasOwnProperty.call(KIND_CATEGORY, evidence.activityKind)
      ? evidence.activityKind
      : undefined;
  const category =
    structuredCategory ?? (structuredKind ? KIND_CATEGORY[structuredKind] : 'thinking');
  return CATEGORY_MOTION[category];
}

export function AgentMotionIndicator({
  motion,
  compact = false,
  presence = 'current',
}: {
  motion: AgentMotionKind;
  compact?: boolean;
  presence?: 'current' | 'exiting';
}) {
  const common = {
    'data-agent-motion': motion,
    'data-agent-motion-size': compact ? 'compact' : 'standard',
    'data-agent-motion-presence': presence,
    'aria-hidden': true,
    style: presence === 'current' ? ({ opacity: 1 } as React.CSSProperties) : undefined,
  } as const;

  let animation: React.ReactNode;

  if (motion === 'glyph-current') {
    animation = (
      <span className="agent-motion agent-motion--glyph-current">
        <span className="agent-motion__word" data-text="VIBE">
          VIBE
        </span>
        <span className="agent-motion__baseline" />
      </span>
    );
  } else if (motion === 'nine-dot-fold') {
    animation = (
      <span className="agent-motion agent-motion--nine-dot-fold">
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} style={{ '--motion-index': index } as React.CSSProperties} />
        ))}
      </span>
    );
  } else if (motion === 'twin-loop') {
    animation = (
      <span className="agent-motion agent-motion--twin-loop">
        <i />
        <i />
      </span>
    );
  } else if (motion === 'breathing-brackets') {
    animation = (
      <span className="agent-motion agent-motion--breathing-brackets">
        <i className="agent-motion__bracket agent-motion__bracket--left">[</i>
        <i className="agent-motion__seed" />
        <i className="agent-motion__bracket agent-motion__bracket--right">]</i>
      </span>
    );
  } else if (motion === 'stack-shift') {
    animation = (
      <span className="agent-motion agent-motion--stack-shift">
        {[0.78, 0.44, 0.62, 0.31].map((fill, index) => (
          <i
            key={index}
            style={{ '--motion-index': index, '--motion-fill': fill } as React.CSSProperties}
          />
        ))}
      </span>
    );
  } else if (motion === 'code-shimmer') {
    animation = (
      <span className="agent-motion agent-motion--code-shimmer">
        {[0.9, 0.64, 0.82, 0.5].map((width, index) => (
          <i
            key={index}
            style={{ '--motion-index': index, '--motion-width': width } as React.CSSProperties}
          />
        ))}
      </span>
    );
  } else {
    animation = (
      <span className="agent-motion agent-motion--cursor-forge">
        <i className="agent-motion__forge-line" />
        <i className="agent-motion__forge-cursor" />
      </span>
    );
  }

  return (
    <span {...common} className="agent-motion-slot">
      {animation}
    </span>
  );
}

const EXIT_TRACE_MS = 1400;

export function PerceptibleAgentMotionIndicator({
  motion,
  compact = false,
}: {
  motion: AgentMotionKind | null;
  compact?: boolean;
}) {
  const previousMotionRef = React.useRef<AgentMotionKind | null>(motion);
  const [exitingMotion, setExitingMotion] = React.useState<AgentMotionKind | null>(null);

  React.useEffect(() => {
    const previousMotion = previousMotionRef.current;
    previousMotionRef.current = motion;
    if (!previousMotion || previousMotion === motion) return;

    setExitingMotion(previousMotion);
    const timeout = window.setTimeout(() => {
      setExitingMotion((current) => (current === previousMotion ? null : current));
    }, EXIT_TRACE_MS);
    return () => window.clearTimeout(timeout);
  }, [motion]);

  if (!motion && !exitingMotion) return null;

  return (
    <span
      className="agent-motion-transition"
      data-agent-motion-transition-size={compact ? 'compact' : 'standard'}
      aria-hidden="true"
    >
      {motion ? (
        <AgentMotionIndicator motion={motion} compact={compact} presence="current" />
      ) : null}
      {exitingMotion ? (
        <AgentMotionIndicator motion={exitingMotion} compact={compact} presence="exiting" />
      ) : null}
    </span>
  );
}
