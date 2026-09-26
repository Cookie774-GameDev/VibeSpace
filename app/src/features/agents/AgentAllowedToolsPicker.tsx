import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToolStore } from '@/features/tools/toolStore';
import { getBuiltinActions } from '@/lib/actions/registry';
import { TOOL_GATEWAY_CATALOG } from '@/lib/harness/toolGatewayProtocol';

interface AgentAllowedToolsPickerProps {
  value: string[];
  onChange: (tools: string[]) => void;
}

const gatewayChoices = TOOL_GATEWAY_CATALOG.map((id) => ({
  id,
  label: id === 'vibespace_context' ? 'VibeSpace Context (RLM) — vibespace_context' : id,
}));
const gatewayIds = new Set<string>(TOOL_GATEWAY_CATALOG);
const builtinChoices = getBuiltinActions()
  .filter((action) => !gatewayIds.has(action.id))
  .map((action) => ({ id: action.id, label: `${action.label} — ${action.id}` }));

function parseTools(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
}

export function AgentAllowedToolsPicker({ value, onChange }: AgentAllowedToolsPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const customTools = useToolStore((state) => state.tools);
  const choices = React.useMemo(
    () => [
      { id: '*', label: 'All available tools (*)' },
      ...gatewayChoices,
      ...builtinChoices,
      ...customTools.map((tool) => ({
        id: `custom.${tool.slug}`,
        label: `${tool.name} — custom.${tool.slug}`,
      })),
    ],
    [customTools],
  );
  const visibleChoices = choices.filter(({ id, label }) =>
    `${label} ${id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = (tool: string) => {
    if (tool === '*') {
      onChange(value.includes('*') ? [] : ['*']);
      return;
    }
    const selected = value.filter((id) => id !== '*');
    onChange(selected.includes(tool) ? selected.filter((id) => id !== tool) : [...selected, tool]);
  };

  return (
    <div
      className="space-y-1.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <Label htmlFor="agent-tools">Allowed tools</Label>
      <Input
        id="agent-tools"
        value={value.join(', ')}
        placeholder="* or tool ids"
        aria-expanded={open}
        aria-controls="agent-vibespace-tools"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => onChange(parseTools(event.target.value))}
      />
      {open ? (
        <div
          id="agent-vibespace-tools"
          role="group"
          aria-label="VibeSpace tools"
          className="max-h-56 overflow-y-auto rounded-md border border-border bg-background p-2 space-y-1"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <span className="text-metadata text-muted-foreground">Choose VibeSpace tools</span>
            <button
              type="button"
              className="text-metadata text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools..."
            aria-label="Search VibeSpace tools"
            className="mb-2"
          />
          {visibleChoices.map(({ id, label }) => {
            const selected = value.includes(id);
            return (
              <button
                key={id}
                type="button"
                role="checkbox"
                aria-checked={selected}
                aria-label={label}
                onClick={() => toggle(id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-metadata hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border"
                >
                  {selected ? '✓' : ''}
                </span>
                <span className="font-mono break-all">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
