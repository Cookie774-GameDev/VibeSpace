import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export function ThemedSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-haspopup="listbox"
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-foreground"
        >
          <span className="truncate">{selected?.label ?? 'Select a chat…'}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-24px)] overflow-hidden border-border bg-background p-1 text-foreground"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() =>
            (
              document
                .getElementById(listId)
                ?.querySelector<HTMLElement>('[aria-selected="true"]') ??
              document.getElementById(listId)?.querySelector<HTMLElement>('[role="option"]')
            )?.focus(),
          );
        }}
      >
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="max-h-[min(320px,50vh)] overflow-y-auto overscroll-contain"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
            ];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-foreground hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <Check className={`h-3 w-3 shrink-0 ${option.value === value ? '' : 'invisible'}`} />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
