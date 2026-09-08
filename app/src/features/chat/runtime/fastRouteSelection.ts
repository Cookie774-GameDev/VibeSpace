import type { ModelPickerOption } from '../../../lib/ai/useAccessibleChatModels';

export function isFastModelRoute(modelId: string): boolean {
  return /-fast$/iu.test(modelId);
}

/** Select only an advertised sibling on the same connection and provider. */
export function findFastModelRoute(
  selection: { modelId: string; connectionId?: string; providerId: string },
  options: readonly ModelPickerOption[],
  enabled: boolean,
): ModelPickerOption | undefined {
  const modelId = selection.modelId.replace(/-fast$/iu, '') + (enabled ? '-fast' : '');
  return options.flatMap((option) => option.alternativeRoutes ?? [option]).find((option) =>
    option.available !== false && option.provider === selection.providerId &&
    option.connectionId === selection.connectionId &&
    option.modelId.toLowerCase() === modelId.toLowerCase(),
  );
}
