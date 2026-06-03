/**
 * Tiny visual chip showing an agent identity. Used wherever an agent is
 * referenced in the UI: composer, message author lines, council activity strip,
 * the AgentPicker, etc.
 *
 * Composable rather than monolithic: variants control size, whether the name
 * shows, and whether the chip is interactive.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { Agent } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { cn, hueFromString } from '@/lib/utils';
import { getAgentIcon } from './icons';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 select-none transition-colors',
  {
    variants: {
      variant: {
        plain: '',
        chip: 'rounded-full border border-border bg-elevated px-2 py-0.5',
        button:
          'rounded-md border border-border bg-elevated hover:bg-muted px-2 py-1 cursor-pointer',
      },
      size: {
        sm: 'text-metadata',
        md: 'text-secondary',
        lg: 'text-body',
      },
    },
    defaultVariants: { variant: 'plain', size: 'md' },
  },
);

const avatarSize = { sm: 14, md: 18, lg: 22 } as const;

export interface AgentBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof badgeVariants> {
  /** The agent to render. */
  agent: Agent;
  /** Show the agent's display name beside the avatar. Default true. */
  showName?: boolean;
  /** Optional accent dot using the agent color (e.g. for active state). */
  showStatus?: boolean;
  /** Optional override of the visible label (default: agent.name). */
  label?: string;
  /** Optional content rendered after the name (e.g. a verb / token count). */
  trailing?: React.ReactNode;
}

/**
 * AgentBadge - the canonical "this is who's speaking" component.
 *
 * Colour is deterministic per agent: explicit `color_hue` if set, otherwise
 * a hash of the agent slug so cloned agents inherit a stable identity.
 */
export const AgentBadge = React.forwardRef<HTMLSpanElement, AgentBadgeProps>(
  (
    {
      agent,
      showName = true,
      showStatus = false,
      label,
      trailing,
      variant,
      size = 'md',
      className,
      ...props
    },
    ref,
  ) => {
    const hue = agent.color_hue ?? hueFromString(agent.slug);
    const sizeKey = size ?? 'md';
    const seed = `${agent.slug}-${hue}`;
    const Icon = getAgentIcon(agent);
    const iconSize = Math.max(10, Math.floor(avatarSize[sizeKey] * 0.66));

    return (
      <span ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props}>
        <Avatar
          size={avatarSize[sizeKey]}
          seed={seed}
          className="ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
        >
          <Icon size={iconSize} strokeWidth={2.4} aria-hidden />
        </Avatar>
        {showName && (
          <span className="font-medium text-foreground truncate max-w-[160px]">
            {label ?? agent.name}
          </span>
        )}
        {showStatus && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: `hsl(${hue}, 70%, 60%)` }}
          />
        )}
        {trailing}
      </span>
    );
  },
);
AgentBadge.displayName = 'AgentBadge';
