import * as React from 'react';
import type {
  ChatActivityCategory,
  ChatActivityKind,
  ChatActivitySemanticIntent,
  ChatActivityStatus,
} from '../activity/types';
import './agent-motion.css';

export type AgentMotionKind =
  | 'glyph-current'
  | 'nine-dot-fold'
  | 'twin-loop'
  | 'cursor-forge'
  | 'breathing-brackets'
  | 'stack-shift'
  | 'code-shimmer'
  | 'book-read'
  | 'search-scan'
  | 'mail-send'
  | 'ship-launch';

export interface AgentMotionEvidence {
  status?: ChatActivityStatus;
  activityCategory?: ChatActivityCategory;
  activityKind?: ChatActivityKind;
  semanticIntent?: ChatActivitySemanticIntent;
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
  if (evidence.semanticIntent === 'mail') return 'mail-send';
  if (evidence.semanticIntent === 'ship') return 'ship-launch';
  if (evidence.activityKind === 'url') return 'search-scan';
  if (evidence.activityKind === 'file' && evidence.activityCategory !== 'writing') {
    return 'book-read';
  }
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
  } else if (motion === 'book-read') {
    animation = (
      <span className="agent-motion agent-motion--book-read">
        <i className="agent-motion__book-cover" />
        <i className="agent-motion__book-page agent-motion__book-page--left" />
        <i className="agent-motion__book-page agent-motion__book-page--right" />
        <i className="agent-motion__book-turn" />
      </span>
    );
  } else if (motion === 'search-scan') {
    animation = (
      <span className="agent-motion agent-motion--search-scan">
        <i className="agent-motion__search-ring" />
        <i className="agent-motion__search-handle" />
        <i className="agent-motion__search-glint" />
      </span>
    );
  } else if (motion === 'mail-send') {
    animation = (
      <span className="agent-motion agent-motion--mail-send">
        <i className="agent-motion__mail-body" />
        <i className="agent-motion__mail-flap" />
        <i className="agent-motion__mail-trail agent-motion__mail-trail--one" />
        <i className="agent-motion__mail-trail agent-motion__mail-trail--two" />
      </span>
    );
  } else if (motion === 'ship-launch') {
    animation = (
      <span className="agent-motion agent-motion--ship-launch">
        <i className="agent-motion__ship-hull" />
        <i className="agent-motion__ship-sail" />
        <i className="agent-motion__ship-wave agent-motion__ship-wave--one" />
        <i className="agent-motion__ship-wave agent-motion__ship-wave--two" />
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

export function PerceptibleAgentMotionIndicator({
  motion,
  compact = false,
}: {
  motion: AgentMotionKind | null;
  compact?: boolean;
}) {
  if (!motion) return null;
  return <AgentMotionIndicator key={motion} motion={motion} compact={compact} />;
}
