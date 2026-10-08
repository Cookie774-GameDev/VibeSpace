import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Context Map focused user-testing repairs', () => {
  it('owns a keyboard-accessible scroll surface for the complete left panel', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('data-context-sidebar-scroll');
    expect(source).toContain('aria-label="Context Map navigation and sources"');
    expect(source).toContain('min-h-0 overflow-y-auto overscroll-y-contain');
  });

  it('opens a focused graph with top instructions and a compact inspector', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('data-context-focused-map');
    expect(source).toContain('Select a node to inspect details, links, and backlinks');
    expect(source).toContain('Esc closes focused view');
    expect(source).toContain('compact');
    expect(source).toContain('await selectMap(mapId)');
    expect(source).toContain(
      'canOpenPartialSiyuanSurface(record, manifest, durableJob, accountId)',
    );
    expect(source.indexOf('canOpenPartialSiyuanSurface(')).toBeLessThan(
      source.indexOf('productionSiyuanContextMaps.sync(', source.indexOf('openFocusedMap')),
    );
  });

  it('keeps every source picker in Context and places nightly maintenance after creation', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('chooseProjectFiles(false');
    expect(source).toContain("setWorkspaceSection('sources')");
    expect(source).not.toContain('<ContextRecoveryNotice');
    expect(source.indexOf('<ContextSourceCards')).toBeLessThan(
      source.indexOf('<NightlySecondBrainPanel'),
    );
    expect(source).toContain('Create map');
  });

  it('opens multi-file selection for summary scope while preserving pasted path entry', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('chooseProjectFiles(true');
    expect(source).toContain("title: 'Choose files to summarize'");
    expect(source).toContain('mergeSiyuanSummaryPaths(current, picked)');
    expect(source).toContain('parseSiyuanSummaryPathDraft(summaryPathDraft)');
    expect(source).toContain('Add pasted path');
    expect(source).toContain('Add files');
  });

  it('backs durable job polling off when maps are idle and pauses it while hidden', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('contextJobPollDelay({');
    expect(source).toContain("document.addEventListener('visibilitychange', schedule)");
    expect(source).not.toContain('window.setInterval(() => void refresh(), 1_000)');
  });

  it('keeps an arbitrary Context source independent from the Files project root', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('getStoredContextSourceRoot(accountId, projectId)');
    expect(source).toContain('setStoredContextSourceRoot(accountId, projectId, rootDir)');
    expect(source).toContain('Context source folder');
    expect(source).not.toContain('getStoredProjectRoot');
    expect(source).not.toContain('setStoredProjectRoot');
  });

  it('populates the physical search index before presenting a new local map as ready', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');
    const createIndex = source.indexOf('const makeSkillTree = React.useCallback(');
    const saveIndex = source.indexOf('const persisted = await savePersistedContextTree(generated, {', createIndex);
    const populateIndex = source.indexOf('await populatePersistedCreatedContextMap({', saveIndex);
    const applyIndex = source.indexOf(
      'if (!applyPersistenceState(completedPersistence)) return',
      saveIndex,
    );
    const readyIndex = source.indexOf("toast.success('Context map ready'", saveIndex);

    expect(source).toContain(
      "import { createContextSearchIndexPopulationPort } from './contextSearchIndexing';",
    );
    expect(createIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeGreaterThan(createIndex);
    expect(populateIndex).toBeGreaterThan(saveIndex);
    expect(source.slice(saveIndex, populateIndex)).toContain(
      "sourceStatus: 'indexing', signal: controller.signal",
    );
    expect(applyIndex).toBeGreaterThan(populateIndex);
    expect(readyIndex).toBeGreaterThan(applyIndex);
    expect(source).toContain('populatePersistedCreatedContextMap({');
  });

  it('shows a warm three-step first-project tutorial without replacing Context systems', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('aria-label="Create your first Context project"');
    expect(source).toContain('Create or choose a project');
    expect(source).toContain('Choose what Jarvis should learn');
    expect(source).toContain('Create the map');
    expect(source).toContain('The real Context Map, RLM, and SiYuan systems stay connected.');
    expect(source).toContain('Existing files are not changed.');
  });

  it('keeps durable indexing progress visible on each active Context Map row', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('aria-label={`Index progress for ${map.name}`}');
    expect(source).toContain('{exactFileCountSummary}');
    expect(source).toContain('indexedItemSummary');
    expect(source).toContain(
      '`≈ ${compactRounded}% · ${compactEta} · ${job.createdNodes.toLocaleString()} nodes`',
    );
    expect(source).toContain(
      '`Paused · ≈${compactRounded}% · ETA ${compactEta} · ${job.createdNodes.toLocaleString()} nodes`',
    );
    expect(source).toContain('siyuanOverallProgressPercent(job)');
    expect(source).toContain('formatSiyuanJobEta(job)');
    expect(source).toContain('role="progressbar"');
    expect(source).toContain('data-siyuan-focused-progress');
    expect(source).toContain(
      '`Summarizing ${indexJobSnapshot.summarized.toLocaleString()} / ${indexJobSnapshot.summaryEligible.toLocaleString()}`',
    );
    expect(source).toContain("? 'Discovering allowed files and folders'");
    expect(source).toContain("? 'Reconciling and finalizing'");
    expect(source).toContain('{focusedProgressLabel}');
  });

  it('does not project an internal Context map as a physical context_map.json file', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');
    const mapRowStart = source.indexOf('const mapRow = (map: ContextMapRecord) => {');
    const mapRowEnd = source.indexOf('function FirstContextMapTutorial()', mapRowStart);
    const mapRow = source.slice(mapRowStart, mapRowEnd);

    expect(mapRow).toContain('contextMapBackingFilePath(map)');
    expect(mapRow).toContain('draggable={!deleted && Boolean(mapFilePath)}');
    expect(mapRow).toContain('if (deleted || !mapFilePath) return;');
    expect(mapRow).toContain('mapFilePath ? (');
    expect(mapRow).toContain('Stored internally');
    expect(mapRow).toContain('{map.rootDir}');
  });

  it('keeps a durable SiYuan job running when the user leaves Context', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).not.toContain("abort('context_unmounted')");
    expect(source).not.toContain("abort('context_map_unmounted')");
    expect(source).toContain('The durable job intentionally outlives this page');
    const selectedMapEffect = source.indexOf(
      "setStatus('Reading this Context Map from SiYuan...')",
    );
    const sync = source.indexOf('productionSiyuanContextMaps.sync(', selectedMapEffect);
    const selectedMapFlow = source.slice(selectedMapEffect, sync);
    const terminalStatusGuard = selectedMapFlow.indexOf("['paused', 'cancelled', 'failed']");
    const authorityCheck = selectedMapFlow.indexOf(
      'hasSiyuanMapJobAuthority(',
      terminalStatusGuard,
    );
    expect(terminalStatusGuard).toBeGreaterThan(-1);
    expect(authorityCheck).toBeGreaterThan(terminalStatusGuard);
    expect(source).toContain("durableJob.status === 'running'");
    expect(source).toContain("if (existing && job?.status !== 'running') return existing;");
  });

  it('requires explicit exact-route cloud approval with recomputed scope disclosure', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain('Approve cloud summaries');
    expect(source).toContain('Privacy warning: approved file samples leave this device');
    expect(source).toContain('No provider or model substitution is allowed.');
    expect(source).toContain('cloudDisclosure.connectionId} · effort {cloudDisclosure.effort}');
    expect(source).toContain('{open ? (');
    expect(source).toContain('computeSiyuanCloudSummaryScope(');
    expect(source).toContain('summaryPolicyFingerprint: job.policyFingerprint');
    expect(source).toContain('archiveAndRestartSiyuanSummaryJobForCloud(');
    expect(source).toContain('cloudApprovalPendingRef.current');
    expect(source).toContain('disabled={cloudApprovalPending}');
    expect(
      source.match(/\['user', 'local_model_unavailable', 'cloud_approval_required'\]\.includes/gu),
    ).toHaveLength(2);
    expect(source).toContain('Cloud approval was saved safely, but resume needs review.');
    const approvalStart = source.indexOf('const approveCloudSummaries');
    const writerSettled = source.indexOf('siyuan_summary_writer_stop_timeout', approvalStart);
    const approvalHandoff = source.slice(approvalStart, writerSettled);
    expect(approvalHandoff).toContain(
      "generationAbortRef.current?.abort('cloud_summary_route_transition')",
    );
    expect(approvalHandoff).not.toContain('indexControlRef.current?.cancel()');
    const authority = source.indexOf('hasSiyuanMapJobAuthority(', writerSettled);
    const saveApproval = source.indexOf('writeSiyuanMapManifest(approvedManifest)', authority);
    const archive = source.indexOf('archiveSiyuanSummaryJobForCloudRestart(', saveApproval);
    const clearNative = source.indexOf('clearArchivedSiyuanSummaryDocuments(', archive);
    const repin = source.indexOf('archiveAndRestartSiyuanSummaryJobForCloud(', clearNative);
    expect(writerSettled).toBeGreaterThan(approvalStart);
    expect(authority).toBeGreaterThan(writerSettled);
    expect(saveApproval).toBeGreaterThan(authority);
    expect(archive).toBeGreaterThan(saveApproval);
    expect(clearNative).toBeGreaterThan(archive);
    expect(repin).toBeGreaterThan(clearNative);
  });

  it('uses the shared Chat model picker and catalog for Context summary selection', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');

    expect(source).toContain("from '@/features/chat/ModelPickerTypeahead'");
    expect(source).toContain('const accessibleSummaryModels = useAccessibleChatModels()');
    expect(source).toContain('<ModelPickerTypeahead');
    expect(source).toContain('initialEffort={selectedEffort}');
    expect(source).toContain('onChange(route.id, effort)');
  });

  it('threads active account and workspace authority into every Context sync', () => {
    const source = readFileSync(resolve('src/features/context/ContextPage.tsx'), 'utf8');
    expect(source).toContain('const workspaceId = useAuthStore((s) => s.workspaceId)');
    const syncCalls = source.match(/productionSiyuanContextMaps\s*\.sync\(/gu) ?? [];
    const workspaceBindings = source.match(/workspaceId[,}]/gu) ?? [];
    expect(syncCalls).toHaveLength(6);
    expect(source).toContain('pauseBeforeSummaries: true');
    const restoreStart = source.indexOf('const restoreMap');
    const restoreEnd = source.indexOf('const openFolderPicker', restoreStart);
    const restoreFlow = source.slice(restoreStart, restoreEnd);
    expect(restoreFlow).toContain('.sync(projectId, restored, {');
    expect(restoreFlow).toContain("error.message === 'siyuan_summary_paused_before_run'");
    expect(workspaceBindings.length).toBeGreaterThanOrEqual(syncCalls.length);
    expect(source).toContain('[accountId, applyPersistenceState, projectId, workspaceId]');
    expect(source).toContain('[accountId, maps, projectId, selectMap, workspaceId]');
    expect(source).toContain('[accountId, applyPersistenceState, maps, projectId, workspaceId]');
    expect(source).toContain('(auth.workspaceId ?? null) === (workspaceId ?? null)');
  });
});
