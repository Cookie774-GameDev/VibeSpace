import { describe, expect, it } from 'vitest';
import { findFastModelRoute, isFastModelRoute } from './fastRouteSelection';
import type { ModelPickerOption } from '../../../lib/ai/useAccessibleChatModels';

describe('explicit Fast route selection', () => {
  const selection = { providerId: 'openai', connectionId: 'opencode-cli', modelId: 'openai/gpt-5.6-luna' };
  const option = (modelId: string, extra = {}): ModelPickerOption => ({
    id: modelId, label: modelId, provider: 'openai', connectionId: 'opencode-cli', modelId, ...extra,
  });
  it('selects the advertised sibling and switches back without changing providers', () => {
    const normal = option(selection.modelId), fast = option(selection.modelId + '-fast');
    const options = [{ ...normal, alternativeRoutes: [normal, fast] }];
    expect(findFastModelRoute(selection, options, true)).toBe(fast);
    expect(findFastModelRoute({ ...selection, modelId: fast.modelId }, options, false)).toBe(normal);
  });
  it('never invents a route or crosses connections', () => {
    expect(findFastModelRoute(selection, [], true)).toBeUndefined();
    expect(findFastModelRoute(selection, [option(selection.modelId + '-fast', { connectionId: 'other' })], true)).toBeUndefined();
    expect(findFastModelRoute(selection, [option(selection.modelId + '-fast', { available: false })], true)).toBeUndefined();
  });
  it('recognizes Fast suffixes for any model without misclassifying model names', () => {
    expect(isFastModelRoute('vendor/any-model-fast')).toBe(true);
    expect(isFastModelRoute('vendor/fast-thinking')).toBe(false);
  });
});
