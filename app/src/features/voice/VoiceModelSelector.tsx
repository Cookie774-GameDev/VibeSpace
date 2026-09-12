import * as React from 'react';
import { useAuthStore } from '@/stores/auth';
import {
  selectionFromOption,
  selectionOptionId,
  type ChatModelSelection,
} from '@/lib/ai/modelSelection';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';

export function VoiceModelSelector({
  selection,
  onSelectionChange,
}: {
  selection?: ChatModelSelection;
  onSelectionChange?: (selection: ChatModelSelection) => void;
}) {
  const storedSelection = useAuthStore((state) => state.chatModelSelection);
  const persistSelection = useAuthStore((state) => state.setChatModelSelection);
  const { groups, flatOptions, hasAny } = useAccessibleChatModels();
  const currentSelection = selection ?? storedSelection;
  const currentOptionId = React.useMemo(() => {
    const exactId = selectionOptionId(currentSelection);
    if (exactId && flatOptions.some((option) => option.id === exactId)) return exactId;
    if (currentSelection.mode !== 'single') return '';
    return (
      flatOptions.find(
        (option) =>
          option.provider === currentSelection.providerId &&
          option.modelId === currentSelection.modelId,
      )?.id ?? ''
    );
  }, [currentSelection, flatOptions]);

  return (
    <label
      className="jarvis-voice-model-selector"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="sr-only">Jarvis voice model</span>
      <select
        aria-label="Jarvis voice model"
        value={currentOptionId}
        disabled={!hasAny}
        onChange={(event) => {
          const option = flatOptions.find((candidate) => candidate.id === event.target.value);
          if (!option || option.available === false) return;
          const nextSelection = selectionFromOption(
            option.provider,
            option.modelId,
            option.connection,
          );
          (onSelectionChange ?? persistSelection)(nextSelection);
        }}
      >
        {!currentOptionId ? <option value="">Select model</option> : null}
        {groups.map((group) => (
          <optgroup key={group.provider} label={group.label}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id} disabled={option.available === false}>
                {option.label}
                {option.available === false ? ' — unavailable' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
