/**
 * Public surface of the agents feature. Anything outside `features/agents/`
 * imports from here.
 */
export { getDefaultAgents } from './registry';
export {
  applyPersona,
  PERSONAS,
  PERSONA_LIST,
  type Persona,
} from './personas';
export { AgentManager } from './AgentManager';
export { AgentDetail } from './AgentDetail';
export { AgentBadge, type AgentBadgeProps } from './AgentBadge';
export { AgentPicker, type AgentPickerProps } from './AgentPicker';
