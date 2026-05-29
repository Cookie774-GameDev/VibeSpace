/**
 * Public surface of the call feature.
 *
 * Import shape:
 *   import {
 *     CallButton,
 *     CallModal,
 *     CallService, getCallService,
 *     useCallStore,
 *     fireOutboundCall, startOutboundTrigger,
 *   } from '@/features/call';
 */

export { CallButton } from './CallButton';
export { CallModal } from './CallModal';
export { CallService, getCallService, resetCallService } from './CallService';
export type { CallServiceOptions } from './CallService';
export { useCallStore } from './store';
export type { CallStatus, CallTranscriptEntry } from './store';
export {
  fireOutboundCall,
  startOutboundTrigger,
  type OutboundReason,
  type OutboundContext,
} from './outbound';
