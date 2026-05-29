import { Command } from 'cmdk';
import { Avatar } from '@/components/ui';
import { cn, colorFromString } from '@/lib/utils';
import type { Agent } from '@/types';

export interface MentionTypeaheadProps {
  /** Agents matching the typeahead query, already filtered + sorted. */
  agents: Agent[];
  /** Currently highlighted agent slug (controlled). */
  selectedSlug: string;
  /** What the user typed after the '@' (used for the empty-state copy). */
  query: string;
  /** Called when user clicks an item or hovers it. */
  onHoverSlug?: (slug: string) => void;
  /** Called when user activates an item (mouse click). Enter handling lives in Composer. */
  onSelect: (agent: Agent) => void;
}

/**
 * The list rendered inside the mention popover. Uses cmdk's Command + List + Item
 * primitives for accessibility, with controlled `value` so the Composer (which keeps
 * focus on its textarea) can drive selection via keyboard.
 *
 * Keyboard handling lives in Composer; this component is presentational.
 */
export function MentionTypeahead({
  agents,
  selectedSlug,
  query,
  onHoverSlug,
  onSelect,
}: MentionTypeaheadProps) {
  return (
    <Command
      shouldFilter={false}
      value={selectedSlug}
      // We control selection externally; this no-op keeps cmdk happy.
      onValueChange={() => {}}
      className="outline-none"
      // Don't let cmdk steal arrow keys from our textarea.
      loop
    >
      <Command.List className="max-h-[260px] overflow-y-auto py-1">
        {agents.length === 0 ? (
          <Command.Empty className="px-3 py-3 text-secondary text-muted-foreground">
            No agents match <span className="font-mono text-foreground">@{query}</span>
          </Command.Empty>
        ) : (
          agents.map((a) => {
            const color = colorFromString(a.slug);
            return (
              <Command.Item
                key={a.id}
                value={a.slug}
                onSelect={() => onSelect(a)}
                onMouseEnter={() => onHoverSlug?.(a.slug)}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 mx-1 rounded cursor-pointer',
                  'text-secondary text-foreground',
                  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
                )}
              >
                <Avatar seed={a.slug} size={20} />
                <span
                  className="font-mono text-secondary"
                  style={{ color }}
                >
                  @{a.slug}
                </span>
                <span className="text-secondary text-foreground truncate">{a.name}</span>
                <span className="ml-auto text-metadata text-muted-foreground truncate max-w-[14ch]">
                  {a.description}
                </span>
              </Command.Item>
            );
          })
        )}
      </Command.List>
    </Command>
  );
}
