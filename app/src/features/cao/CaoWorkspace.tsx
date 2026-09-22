import { lazy, Suspense, useState } from 'react';
import { CaoMissionPanel, type CaoMissionController } from './CaoMissionPanel';
import type { CaoControlScope } from './controlCommand';
import './cao-controls.css';
const Perspectives = lazy(() =>
  import('@/features/council/CouncilWorkflowPage').then((module) => ({
    default: module.CouncilPerspectivesPanel,
  })),
);

export function CaoWorkspace({
  scope,
  chatId,
  controller,
}: {
  scope: CaoControlScope;
  chatId: string;
  controller?: CaoMissionController;
}) {
  const [view, setView] = useState<'mission' | 'perspectives'>('mission');
  return (
    <div className="cao-workspace">
      <div className="cao-workspace-tabs" role="tablist" aria-label="Council workspace">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'mission'}
          onClick={() => setView('mission')}
        >
          CAO mission
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'perspectives'}
          onClick={() => setView('perspectives')}
        >
          Perspectives & critic
        </button>
      </div>
      <div hidden={view !== 'mission'}>
        <CaoMissionPanel
          key={JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId])}
          scope={scope}
          callerChatId={chatId}
          controller={controller}
        />
      </div>
      {view === 'perspectives' && (
        <Suspense fallback={<p className="p-5 text-sm">Loading Council…</p>}>
          <Perspectives chatId={chatId} embedded />
        </Suspense>
      )}
    </div>
  );
}
