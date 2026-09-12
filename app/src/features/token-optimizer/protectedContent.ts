import type { ContextBudgetKind } from './contracts';

const PROTECTED_CONTEXT_KINDS = new Set<ContextBudgetKind>([
  'system_instruction',
  'latest_user_message',
  'explicit_attachment',
  'pinned_context_node',
  'tool_schema',
  'approval_requirement',
  'quoted_preserved_text',
  'exact_patch',
  'structured_tool_data',
  'secret_detection_warning',
]);

export function isProtectedContext(kind: ContextBudgetKind): boolean {
  return PROTECTED_CONTEXT_KINDS.has(kind);
}
