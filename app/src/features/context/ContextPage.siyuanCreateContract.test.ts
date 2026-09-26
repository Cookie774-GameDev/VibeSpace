import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'ContextPage.tsx'), 'utf8');
const creationLifecycleSource = readFileSync(
  resolve(__dirname, 'contextMapCreationLifecycle.ts'),
  'utf8',
);

describe('ContextPage SiYuan creation contract', () => {
  it('creates native maps without a provider credential gate or legacy source writer', () => {
    expect(source).toContain('createSiyuanMetadataSeed(projectId, rootDir)');
    expect(source).not.toContain('generateProjectContextTree({');
    expect(source).not.toContain('Provider key missing');
    expect(source).not.toContain('Map model provider');
  });

  it('prewarms SiYuan and projects every created local or GitHub map', () => {
    expect(source).toContain('productionSiyuanContextMaps.prewarm(projectId)');
    expect(source).toContain('productionSiyuanContextMaps.sync(projectId, persistedMap, {');
    expect(source).toContain('productionSiyuanContextMaps.sync(projectId, generatedMap, {');
    expect(source).toContain("useState<SiyuanSummaryMode>('selected')");
    expect(source).toMatch(/cloud use always asks before sending\s+anything/u);
    expect(source).not.toContain('complete allowed folder structure is indexed');
    expect(source).toContain('onPause={() =>');
    expect(source).toContain('.pause(projectId, indexJobSnapshot.mapId)');
    expect(source).toContain("generationAbortRef.current?.abort('siyuan_index_paused')");
    expect(source).toContain("setStatus('Pausing the SiYuan index safely…')");
    expect(source).toContain('onResume={() =>');
    expect(source).toContain('updateSiyuanIndexJobStatus(');
    expect(source).toContain("abort('user_cancelled')");
    expect(source).toContain('Review privacy and exclusions');
    expect(source).toContain('Additional excluded paths');
    expect(source).toContain('expectedUpdatedAt: persistedMap.updatedAt');
    expect(source).toContain('files indexed with SiYuan');
  });

  it('keeps the exact-parent native creation repair in the official SiYuan path', () => {
    expect(source).toContain('productionSiyuanContextMaps.sync(projectId, generatedMap, {');
    expect(source).toContain('summarySelectedPaths');
    expect(source).not.toContain('createCustomContextMap');
  });

  it('binds the selected cloud summary route to the new map and pauses before any inference', () => {
    const creationStart = source.indexOf('const makeSkillTree = React.useCallback(async () => {');
    const creationEnd = source.indexOf('React.useEffect(() => {', creationStart);
    const creation = source.slice(creationStart, creationEnd);
    const persisted = creation.indexOf(
      'const persisted = await savePersistedContextTree(generated);',
    );
    const preference = creation.indexOf('persistedMap.id,', persisted);
    const sync = creation.indexOf(
      'productionSiyuanContextMaps.sync(projectId, generatedMap, {',
      preference,
    );

    expect(creationStart).toBeGreaterThan(-1);
    expect(creationEnd).toBeGreaterThan(creationStart);
    expect(creation).toContain('const selectedCloudSummaryRoute =');
    expect(creation).toContain('selectedSummaryModel?.connectionId');
    expect(creation).toContain('!isLocalProvider(selectedSummaryModel.provider)');
    expect(persisted).toBeGreaterThan(-1);
    expect(preference).toBeGreaterThan(persisted);
    expect(sync).toBeGreaterThan(preference);
    expect(creation).toContain('writeSiyuanSummaryRoutePreference(');
    expect(creation).toContain('effort: summaryModelEffort');
    expect(creation).toContain('approvalPreflight: Boolean(selectedCloudSummaryRoute)');
    expect(creation).toContain("error.message !== 'siyuan_cloud_summary_scope_ready'");
    expect(creation).toContain('productionSiyuanContextMaps.read(projectId, generatedMap)');
  });

  it('lets the first map choose its exact summary model before creation', () => {
    const summaries = source.indexOf('Every eligible item discovered by the safe scan');
    const createButton = source.indexOf('onClick={() => void makeSkillTree()}', summaries);
    const picker = source.indexOf('data-siyuan-create-summary-model-picker', summaries);

    expect(summaries).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(summaries);
    expect(picker).toBeLessThan(createButton);
    expect(source.slice(picker, createButton)).toContain('<SiyuanSummaryModelPicker');
    expect(source.slice(picker, createButton)).toContain('onChange={selectSummaryModel}');
  });

  it('preserves fresh local ingestion eligibility through RLM and SiYuan creation', () => {
    expect(source).toContain('populatePersistedCreatedContextMap({');
    expect(creationLifecycleSource).toContain(
      'const generatedMap: ContextMapRecord = { ...persistedMap, tree: input.tree }',
    );
    expect(creationLifecycleSource).toContain(
      'input.populateCreatedMap(input.persisted.accountId, generatedMap, input.signal)',
    );
    const creationStart = source.indexOf('const makeSkillTree = React.useCallback(async () => {');
    const creationEnd = source.indexOf('React.useEffect(() => {', creationStart);
    const creation = source.slice(creationStart, creationEnd);
    const completedTree = creation.indexOf('buildProjectContextTreeFromSiyuanIndex(');
    const completedSave = creation.indexOf(
      'completedPersistence = await savePersistedContextTree(completedTree, {',
      completedTree,
    );
    const completedPopulation = creation.indexOf(
      'contextSearchIndexPopulation.populateCreatedMap(',
      completedSave,
    );

    expect(completedTree).toBeGreaterThan(-1);
    expect(completedSave).toBeGreaterThan(completedTree);
    expect(completedPopulation).toBeGreaterThan(completedSave);
    expect(creation).toContain('projectSiyuanMapForContextSearch(completedMap)');
  });

  it('hydrates older paused or completed SiYuan maps into durable Context and RLM state', () => {
    expect(source).toContain('const indexedTreeHydrationRef = React.useRef');
    expect(source).toContain("['paused', 'completed'].includes(indexJobSnapshot.status)");
    expect(source).toContain('buildProjectContextTreeFromSiyuanIndex(selectedMap.tree, entries)');
    expect(source).toContain('expectedUpdatedAt: selectedMap.updatedAt');
    expect(source).toContain('contextSearchIndexPopulation.repairEmptyMap(');
    expect(source).toContain('projectSiyuanMapForContextSearch(completedMap)');
    expect(source).toContain('applyPersistenceState(persisted)');
    expect(source).not.toContain("controller.abort('siyuan_context_map_hydration_detached')");
  });

  it('labels a bounded source preview honestly instead of claiming every source file was mapped', () => {
    expect(source).toContain(
      'const treeCoverageBounded = tree ? isContextTreeCoverageBounded(tree) : false',
    );
    expect(source).toContain('treeCoverageBounded');
    expect(source).toContain('Bounded preview');
  });

  it('opens an exact map as a dedicated official SiYuan page inside the Context route', () => {
    expect(source).toContain("SiyuanVaultSurface } from './siyuan/SiyuanVaultSurface'");
    expect(source).toContain('data-context-siyuan-map-page');
    expect(source).toContain('<SiyuanVaultSurface');
    expect(source).toContain('mapId={selectedMap.id}');
    expect(source).toContain('Back to Context Maps');
    expect(source).toContain('Official SiYuan map · source files stay read-only');
    expect(source).toContain('onExitFocus={closeFocusedMap}');
    expect(source).not.toContain('Open vault');
  });

  it('shows an accessible reduced-motion-safe animation while a Context Map is working', () => {
    expect(source).toContain('data-testid="siyuan-working-animation"');
    expect(source).toContain('density="fine"');
    expect(source).toContain("failed={job.status === 'failed'}");
    expect(source).toContain("? 'Failed · repair needed'");
    expect(source).toContain('label="SiYuan map creation progress"');
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toContain('progress={exactPercent}');
    expect(source).toContain("paused={job.status !== 'running'}");
    expect(source).toContain("estimated={job.phase !== 'completed'}");
    expect(source).toContain('data-testid="siyuan-paused-timing"');
    expect(source).toContain('ETA ${eta} · elapsed ${elapsed}');
    expect(source).toContain("? 'Estimating time…'");
    expect(source).toContain("`${job.phase === 'completed' ? '' : '≈ '}");
  });

  it('offers an explicit safe restart only for terminal failed or cancelled jobs', () => {
    expect(source).toContain("job.status === 'failed' || job.status === 'cancelled'");
    expect(source).toContain('Restart safely');
    expect(source).toContain('createSiyuanIndexJob({');
    expect(source).toContain('await archiveAndReplaceSiyuanIndexJob(restarted');
    expect(source).toContain('existing managed SiYuan nodes will be reused');
  });

  it('resumes an approved identical cloud route without clearing completed summary work', () => {
    const sameRouteResume = source.indexOf(
      'const resumed = await resumeSiyuanSummaryJobWithSameCloudRoute(',
    );
    const destructiveArchive = source.indexOf(
      'const archive = await archiveSiyuanSummaryJobForCloudRestart(',
      sameRouteResume,
    );

    expect(source).toContain('const samePinnedRoute =');
    expect(source).toContain('Approved the same exact route. Resuming pending summaries');
    expect(sameRouteResume).toBeGreaterThan(-1);
    expect(destructiveArchive).toBeGreaterThan(sameRouteResume);
  });

  it('resumes persisted exact-route consent with a fresh clock and without rewriting approval', () => {
    const recoveryStart = source.indexOf(
      'const resumeApprovedCloudSummaries = React.useCallback(async () => {',
    );
    const recoveryEnd = source.indexOf(
      'const reconcileCloudSummaryScopeBeforeApproval = React.useCallback(',
      recoveryStart,
    );
    const recovery = source.slice(recoveryStart, recoveryEnd);

    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    expect(source).toContain('Resume approved exact route');
    expect(source).toContain('Approve exact route and resume');
    expect(recovery).toContain('approvedCloudSiyuanSummaryIdentity({');
    expect(recovery).toContain('hasSiyuanMapJobAuthority(selectedMap, manifest, job, accountId)');
    expect(recovery).toContain('const resumedAt = Date.now();');
    expect(recovery).toContain('resumeSiyuanSummaryJobWithSameCloudRoute(');
    expect(recovery).toContain('exactApprovedIdentity,\n      resumedAt,');
    expect(recovery).not.toContain('updateSiyuanMapManifest(');
    expect(recovery).not.toContain('writeSiyuanMapManifest(');
    expect(recovery).not.toContain('cloudSummaryApproval:');
    expect(recovery).not.toContain('approvedAt');
    expect(recovery).not.toContain('archiveSiyuanSummaryJobForCloudRestart');
    expect(recovery).not.toContain('archiveAndRestartSiyuanSummaryJobForCloud');
    expect(recovery).not.toContain('resetSiyuanSummaryEntry');
    expect(recovery).not.toContain('updateSiyuanIndexJobStatus(');

    const approvalStart = source.indexOf(
      'const approveCloudSummaries = React.useCallback(async () => {',
    );
    const approvedAt = source.indexOf('const approvedAt = Date.now();', approvalStart);
    const approvalBeforeWrite = source.slice(approvalStart, approvedAt);
    const validator = approvalBeforeWrite.indexOf('approvedCloudSiyuanSummaryIdentity({');
    const resume = approvalBeforeWrite.indexOf('await resumeApprovedCloudSummaries();');
    expect(approvedAt).toBeGreaterThan(approvalStart);
    expect(validator).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(validator);
    expect(approvalBeforeWrite).toContain('const persistedApprovalMatchesSelectedRoute =');
    expect(approvalBeforeWrite).toContain('approvedCloudSiyuanSummaryIdentity({');
    expect(approvalBeforeWrite).toContain('await resumeApprovedCloudSummaries();');
    expect(approvalBeforeWrite).toContain(
      "error.message !== 'siyuan_cloud_summary_approval_scope_drift'",
    );
  });

  it('discloses and approves only remaining persisted summary work', () => {
    expect(source).not.toMatch(
      /computeSiyuanCloudSummaryScope\(\s*entries\.map\(resetSiyuanSummaryEntry\)/gu,
    );
    expect(source.match(/computeSiyuanCloudSummaryScope\(\s*entries,/gu)).toHaveLength(3);
  });

  it('reconciles durable entries before persisting a fresh cloud approval', () => {
    const approvalStart = source.indexOf(
      'const approveCloudSummaries = React.useCallback(async () => {',
    );
    const approvalEnd = source.indexOf(
      'const refreshCloudSummaryScope = React.useCallback(async () => {',
      approvalStart,
    );
    const approval = source.slice(approvalStart, approvalEnd);
    const preflight = approval.indexOf('await reconcileCloudSummaryScopeBeforeApproval(');
    const approvalWrite = approval.indexOf('const approvedAt = Date.now();');

    expect(preflight).toBeGreaterThan(-1);
    expect(approvalWrite).toBeGreaterThan(preflight);
    expect(approval).toContain('if (!reconciledApprovalScope) return;');
    expect(approval).toContain('const { job, entries, manifest } = reconciledApprovalScope;');
    expect(source).toContain('assertSiyuanCloudApprovalPreflightReady(job, controller.signal);');
  });

  it('refreshes changed file membership without approving or dispatching summaries', () => {
    const refreshStart = source.indexOf(
      'const refreshCloudSummaryScope = React.useCallback(async () => {',
    );
    const effectStart = source.indexOf('React.useEffect(() => {', refreshStart);
    const refresh = source.slice(refreshStart, effectStart);
    expect(source).toContain('Refresh file scope');
    expect(source).toContain("job.phase === 'creating_nodes'");
    expect(source).toContain("!['creating_nodes', 'summarizing'].includes(job.phase)");
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refresh).toContain('hasSiyuanMapJobAuthority(selectedMap, manifest, job, accountId)');
    expect(refresh).toContain("!['creating_nodes', 'summarizing'].includes(job.phase)");
    expect(refresh).toContain('forceScopeReconcileRef.current = {');
    expect(refresh).toContain('mapId: selectedMap.id,');
    expect(refresh).toContain('requestId: crypto.randomUUID(),');
    expect(refresh).toContain('forceScopeReconcileRef.current) return;');
    expect(refresh).not.toContain('updateSiyuanMapManifest(');
    expect(refresh).not.toContain('writeSiyuanMapManifest(');
    expect(refresh).not.toContain('resumeSiyuanSummaryJobWithSameCloudRoute(');
    expect(source).toContain('refreshIntent.projectId === projectId');
    expect(source).toContain('refreshIntent.mapId === selectedMap.id');
    expect(source).toContain("updateSiyuanIndexJobStatus(projectId, selectedMap.id, 'running')");
    expect(source).toContain("durableJob?.status === 'running'");
    expect(source).toContain("updateSiyuanIndexJobStatus(projectId, selectedMap.id, 'paused')");
    expect(source).toContain('const existing = forceReconcile');
    expect(source).toContain("throw new Error('siyuan_cloud_summary_scope_refresh_detached')");
    expect(source).toContain("throw new Error('siyuan_cloud_summary_scope_refresh_terminal')");
    expect(source).toContain("durableJob.status !== 'running'");
    expect(source).toContain('if (!forceReconcile || refreshIntentCleared)');
    expect(source).toContain('forceReconcile,');
  });

  it('keeps Resume available exactly once while paused node creation can refresh scope', () => {
    const actionsStart = source.indexOf("{job.phase !== 'completed' ? (");
    const actionsEnd = source.indexOf('</section>', actionsStart);
    const actions = source.slice(actionsStart, actionsEnd);

    expect(actionsStart).toBeGreaterThan(-1);
    expect(actions).toContain("job.phase === 'creating_nodes'");
    expect(actions).toContain('onClick={onRefreshScope}');
    expect(actions.match(/onClick=\{onResume\}/gu)).toHaveLength(1);
    expect(actions).not.toContain("job.phase !== 'creating_nodes'");
  });

  it('restarts durable execution even when a stale controller still exists', () => {
    const resumeStart = source.indexOf('onResume={() => {');
    const resumeEnd = source.indexOf('onCancel={() => {', resumeStart);
    const resume = source.slice(resumeStart, resumeEnd);

    expect(resumeStart).toBeGreaterThan(-1);
    expect(resume).toContain('indexControlRef.current?.resume();');
    expect(resume).toContain('setIndexResumeNonce((value) => value + 1);');
    expect(resume).not.toContain('else setIndexResumeNonce');
  });

  it('shows a native string error when opening a SiYuan Context Map fails', () => {
    const errorStart = source.indexOf("'SiYuan Context Map unavailable',");
    const errorEnd = source.indexOf("'Unknown local vault error',", errorStart);
    expect(errorStart).toBeGreaterThan(-1);
    expect(source.slice(errorStart, errorEnd)).toContain("typeof error === 'string' && error.trim()");
  });
});
