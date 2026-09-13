import { beforeEach, expect, it, vi } from 'vitest';
import { clearOpenCodeApprovalStatuses, readOpenCodeApprovalStatus, recordOpenCodeApprovalStatus, subscribeOpenCodeApprovalStatuses } from './openCodeApprovalState';
beforeEach(clearOpenCodeApprovalStatuses);
it('notifies subscribers only on changes and supports unsubscribe', () => {
  const listener = vi.fn(); const unsubscribe = subscribeOpenCodeApprovalStatuses(listener);
  recordOpenCodeApprovalStatus('s', 'p', 'approved');
  recordOpenCodeApprovalStatus('s', 'p', 'approved');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(readOpenCodeApprovalStatus('other', 'p')).toBeUndefined();
  clearOpenCodeApprovalStatuses(); expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe(); recordOpenCodeApprovalStatus('s', 'p', 'denied');
  expect(listener).toHaveBeenCalledTimes(2);
});
