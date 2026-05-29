import * as React from 'react';
import { motion } from 'motion/react';
import { Pin, FolderTree, MessageSquare, Bot, Sparkles, FileText } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { cn } from '@/lib/utils';

/**
 * NavPane - 240px when expanded, 56px when collapsed.
 *
 * Sections (top to bottom):
 *   Pinned, Projects, Chats, Agents, Skills, Files
 *
 * Cmd+B toggles via useUIStore.toggleNav. Width animates with the global
 * Voltage spring; content swaps between expanded/collapsed layouts based
 * on navOpen so the icon-only column reads cleanly when collapsed.
 */
export function NavPane() {
  const navOpen = useUIStore((s) => s.navOpen);
  const agents = useAgentStore((s) => s.agents);
  const agentList = React.useMemo(() => Object.values(agents), [agents]);

  return (
    <motion.aside
      aria-label="Navigation"
      className="shrink-0 overflow-hidden bg-panel border-r border-border"
      initial={false}
      animate={{ width: navOpen ? 240 : 56 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden scrollbar-hidden">
        <NavSection title="Pinned" icon={<Pin className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="Pin chats to keep them close." />
        </NavSection>

        <NavSection title="Projects" icon={<FolderTree className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="No projects yet." />
        </NavSection>

        <NavSection title="Chats" icon={<MessageSquare className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="Recent chats appear here." />
        </NavSection>

        <NavSection title="Agents" icon={<Bot className="h-4 w-4" />} navOpen={navOpen}>
          {agentList.length === 0 ? (
            <EmptyHint navOpen={navOpen} text="No agents loaded." />
          ) : (
            agentList.map((a) => (
              <NavItem
                key={a.id}
                navOpen={navOpen}
                label={a.name}
                icon={<Avatar seed={a.slug} size={16} />}
              />
            ))
          )}
        </NavSection>

        <NavSection title="Skills" icon={<Sparkles className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="No skills installed." />
        </NavSection>

        <NavSection title="Files" icon={<FileText className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="Search project files." />
        </NavSection>
      </div>
    </motion.aside>
  );
}

interface NavSectionProps {
  title: string;
  icon: React.ReactNode;
  navOpen: boolean;
  children?: React.ReactNode;
}

function NavSection({ title, icon, navOpen, children }: NavSectionProps) {
  if (!navOpen) {
    return (
      <section className="flex flex-col items-center gap-1 px-2 pb-2 pt-3" aria-label={title}>
        <span className="text-muted-foreground/60" title={title}>
          {icon}
        </span>
        <div className="flex w-full flex-col items-stretch gap-0.5">{children}</div>
      </section>
    );
  }
  return (
    <section className="px-2 pb-3 pt-3">
      <header className="flex items-center gap-2 px-2 pb-1.5 text-metadata uppercase tracking-wider text-muted-foreground">
        <span className="opacity-70">{icon}</span>
        <span>{title}</span>
      </header>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  navOpen: boolean;
  active?: boolean;
  onClick?: () => void;
}

function NavItem({ icon, label, navOpen, active, onClick }: NavItemProps) {
  if (!navOpen) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          active && 'bg-muted',
        )}
      >
        <span className="shrink-0">{icon}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-foreground transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-muted',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

function EmptyHint({ navOpen, text }: { navOpen: boolean; text: string }) {
  if (!navOpen) return null;
  return <p className="px-2 py-1 text-metadata text-muted-foreground/60">{text}</p>;
}
