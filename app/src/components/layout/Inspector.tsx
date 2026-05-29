import * as React from 'react';
import { motion } from 'motion/react';
import { Boxes, Wrench, GitBranch, Link2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

/**
 * Inspector - 320px right pane, mounted/unmounted via AnimatePresence
 * inside AppShell. Cmd+\ toggles via useUIStore.toggleInspector.
 *
 * The shell renders only the tab UI + placeholders here. Actual content
 * for Trace / Tools / Memory is provided by other subagents.
 */
export function Inspector() {
  return (
    <motion.aside
      aria-label="Inspector"
      className="shrink-0 overflow-hidden bg-panel border-l border-border"
      initial={{ width: 0 }}
      animate={{ width: 320 }}
      exit={{ width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="flex h-full w-[320px] flex-col">
        <Tabs defaultValue="context" className="flex h-full flex-col">
          <div className="px-3 pt-3">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="context" className="gap-1">
                <Boxes className="h-3.5 w-3.5" />
                <span>Context</span>
              </TabsTrigger>
              <TabsTrigger value="tools" className="gap-1">
                <Wrench className="h-3.5 w-3.5" />
                <span>Tools</span>
              </TabsTrigger>
              <TabsTrigger value="trace" className="gap-1">
                <GitBranch className="h-3.5 w-3.5" />
                <span>Trace</span>
              </TabsTrigger>
              <TabsTrigger value="refs" className="gap-1">
                <Link2 className="h-3.5 w-3.5" />
                <span>Refs</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="context"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Context"
              body="Memory items, files, and runtime state the active agent is using."
            />
          </TabsContent>
          <TabsContent
            value="tools"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Tools"
              body="Tool-call history with arguments and results, expandable inline."
            />
          </TabsContent>
          <TabsContent
            value="trace"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Trace"
              body="Workflow timeline with agent rows, tool spans, and token costs."
            />
          </TabsContent>
          <TabsContent
            value="refs"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="References"
              body="Source references for the current message. Click any item to open it."
            />
          </TabsContent>
        </Tabs>
      </div>
    </motion.aside>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-ui-strong text-foreground">{title}</p>
      <p className="text-secondary text-muted-foreground">{body}</p>
    </div>
  );
}
