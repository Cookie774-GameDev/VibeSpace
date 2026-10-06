import * as React from 'react';
import { useAuthStore } from '@/stores/auth';
import {
  selectionFromOption,
  selectionOptionId,
  type ChatModelSelection,
} from '@/lib/ai/modelSelection';
import { useAccessibleChatModels } from '@/lib/ai/useAccessibleChatModels';
import { voiceProviderForConnectionId } from './voiceProviderSelection';

export function VoiceModelSelector({
  selection,
  onSelectionChange,
}: {
  selection?: ChatModelSelection;
  onSelectionChange?: (selection: ChatModelSelection) => void;
}) {
  const storedSelection = useAuthStore((state) => state.chatModelSelection);
  const persistSelection = useAuthStore((state) => state.setChatModelSelection);
  const setMainProvider = useAuthStore((state) => state.setVoiceMainAgentProvider);
  const { groups } = useAccessibleChatModels();
  const routes = React.useMemo(
    () =>
      groups.flatMap((group) =>
        group.options.flatMap((option) => option.alternativeRoutes ?? [option]),
      ),
    [groups],
  );
  const routeSupported = (option: (typeof routes)[number]) =>
    Boolean(
      voiceProviderForConnectionId(option.connectionId) &&
      option.connection?.id === option.connectionId,
    );
  const hasAny = routes.some((option) => option.available === true && routeSupported(option));
  const currentSelection = selection ?? storedSelection;
  const currentOptionId = React.useMemo(() => {
    const exactId = selectionOptionId(currentSelection);
    if (exactId && routes.some((option) => option.id === exactId)) return exactId;
    if (currentSelection.mode !== 'single') return '';
    if (currentSelection.connectionId) return '';
    return (
      routes.find(
        (option) =>
          option.provider === currentSelection.providerId &&
          option.modelId === currentSelection.modelId,
      )?.id ?? ''
    );
  }, [currentSelection, routes]);
  const currentGroupLabel = React.useMemo(
    () =>
      groups.find((group) =>
        group.options.some((option) =>
          (option.alternativeRoutes ?? [option]).some((route) => route.id === currentOptionId),
        ),
      )?.label,
    [currentOptionId, groups],
  );

  return (
    <label
      className="jarvis-voice-model-selector"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="jarvis-model-label">Model</span>
      <span className="jarvis-model-provider" aria-hidden="true">
        {currentGroupLabel ?? 'Choose provider'}
      </span>
      <select
        aria-label="Jarvis voice model"
        value={currentOptionId}
        disabled={!hasAny}
        onChange={(event) => {
          const option = routes.find((candidate) => candidate.id === event.target.value);
          if (!option || option.available !== true || !routeSupported(option)) return;
          const mainProvider = voiceProviderForConnectionId(option.connectionId)!;
          const nextSelection = selectionFromOption(
            option.provider,
            option.modelId,
            option.connection,
          );
          (onSelectionChange ?? persistSelection)(nextSelection);
          setMainProvider(mainProvider);
        }}
      >
        {!currentOptionId ? <option value="">Select model</option> : null}
        {groups.map((group) => (
          <optgroup key={group.id ?? `${group.provider}:${group.label}`} label={group.label}>
            {group.options
              .flatMap((option) => option.alternativeRoutes ?? [option])
              .map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={option.available !== true || !routeSupported(option)}
                >
                  {option.label}
                  {!routeSupported(option)
                    ? ' — unavailable for Jarvis voice'
                    : option.available !== true
                      ? ' — unavailable'
                      : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
