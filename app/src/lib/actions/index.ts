/**
 * Action system barrel — single import point for the action layer.
 *
 * Consumers:
 *   - `lib/ai/runtime.ts` — `applyAvailableActions`, `parseActionBlocks`
 *   - `features/chat/ActionApprovalCard.tsx` — `runAction`, `resolveAction`
 *   - `features/actions/ActionPalette.tsx` — `getAllActions`, `runAction`
 *
 * Anything not re-exported here is intentionally module-internal.
 */

export type {
  ActionCategory,
  ActionDef,
  ActionParam,
  ActionParamType,
  ActionResult,
  ActionRunContext,
  ActionStatus,
  ParsedActionProposal,
} from './types';

export {
  getBuiltinAction,
  getBuiltinActions,
  BUILTIN_ACTION_COUNT,
  CATEGORY_LABELS,
  CATEGORY_ICON,
} from './registry';

export { runAction, resolveAction, getAllActions } from './runner';

export { parseActionBlocks } from './parse';
export type { ParsedSegment, ParseResult } from './parse';

export { applyAvailableActions, buildAddendumText } from './promptAddendum';
