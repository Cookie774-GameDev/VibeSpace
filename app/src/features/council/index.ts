/**
 * Council mode - public API.
 *
 * The council UI shows multiple AI agents working in parallel on the same
 * prompt, each in its own panel, with animated beams visualizing data flow
 * during cross-agent activity. A Synthesize CTA at the top merges their
 * answers via a downstream Critic agent.
 *
 * Internal components (AgentPanel, CouncilGrid, AnimatedBeam, BeamLayer,
 * SynthesizeButton) are intentionally not re-exported - they are wired
 * together by CouncilView and should not be consumed directly by other
 * features.
 */
export { CouncilView, type CouncilViewProps } from './CouncilView';
export { CouncilToggle, type CouncilToggleProps } from './CouncilToggle';
