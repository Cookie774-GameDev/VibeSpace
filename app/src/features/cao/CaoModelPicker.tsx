import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelPickerTypeahead } from '@/features/chat/ModelPickerTypeahead';
import { useAccessibleChatModels, type ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import type { EffortLabel } from '@/lib/ai/catalog/modelVariants';

/** Uses the chat catalog and the chat model → route → effort UI without a second effort list. */
export function CaoModelPicker({
  label,
  value,
  effort,
  disabled,
  allow,
  onSelect,
}: {
  label: string;
  value?: {
    modelId: string;
    connectionId?: string;
    providerId?: string;
    connection?: { id: string };
  };
  effort: string;
  disabled?: boolean;
  allow?: (option: ModelPickerOption) => boolean;
  onSelect: (option: ModelPickerOption, effort: string) => void;
}) {
  const { groups } = useAccessibleChatModels();
  const [open, setOpen] = useState(false);
  const filtered = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          options: group.options.flatMap((option) => {
            const routes = [option, ...(option.alternativeRoutes ?? [])].filter(
              (route) => route.available !== false && (!allow || allow(route)),
            );
            return routes.length
              ? [
                  {
                    ...routes[0]!,
                    alternativeRoutes: routes.length > 1 ? routes.slice(1) : undefined,
                  },
                ]
              : [];
          }),
        }))
        .filter((group) => group.options.length),
    [groups, allow],
  );
  const routes = filtered.flatMap((group) =>
    group.options.flatMap((option) => [option, ...(option.alternativeRoutes ?? [])]),
  );
  const selected = routes.find(
    (option) =>
      option.modelId === value?.modelId &&
      (option.connectionId ?? option.connection?.id) ===
        (value?.connectionId ?? value?.connection?.id) &&
      (!value?.providerId || option.provider === value.providerId),
  );
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={label}
            className="h-auto min-h-12 w-full justify-between gap-3 px-4 py-3 text-left"
          >
            <span className="min-w-0">
              <span className="block truncate">{selected?.label ?? 'Choose a model'}</span>
              {selected && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {selected.connection?.displayName ?? selected.connectionId} · {effort}
                </span>
              )}
            </span>
            <ChevronDown className="size-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="z-[150] w-auto max-w-[calc(100vw-2rem)] border-0 bg-transparent p-0 shadow-none"
        >
          <ModelPickerTypeahead
            groups={filtered}
            selectedId={selected?.id ?? ''}
            initialEffort={effort as EffortLabel}
            onSelect={(provider, modelId, connection, nextEffort) => {
              const option = routes.find(
                (route) =>
                  route.provider === provider &&
                  route.modelId === modelId &&
                  (route.connectionId ?? route.connection?.id) === connection?.id,
              );
              if (option) {
                onSelect(option, nextEffort);
                setOpen(false);
              }
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
