function queryResult(promise, label) {
  return promise.then((result) => ({ label, data: result.data ?? null, error: result.error ?? null })).catch((error) => ({ label, data: null, error }));
}
async function invokeUsageFunction(name) {
  try { const result = await vibeSupabase.functions.invoke(name, { body: {} }); return { label: name, data: result.data ?? null, error: result.error ?? null }; }
  catch (error) { return { label: name, data: null, error }; }
}
async function loadDashboardData(user, generation) {
  const lookback = new Date(Date.now() - USAGE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const results = await Promise.all([
    queryResult(vibeSupabase.from('profiles').select('display_name,tier,monthly_quota,default_provider,default_local_model,updated_at').eq('id', user.id).maybeSingle(), 'profile'),
    queryResult(vibeSupabase.from('subscriptions').select('id,plan,status,price_id,current_period_start,current_period_end,cancel_at_period_end,canceled_at,trial_end,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(1).maybeSingle(), 'subscription'),
    queryResult(vibeSupabase.from('desktop_presence').select('user_id,device_id,display_name,app_version,is_online,last_seen_at,active_runtime,provider_usage,background_task_count,recent_sync_at,revoked_at,updated_at').eq('user_id', user.id).order('last_seen_at', { ascending: false }), 'devices'),
    queryResult(vibeSupabase.from('dashboard_terminal_snapshots').select('user_id,device_id,session_id,pane_id,project_id,project_name,title,agent_slug,command_label,request_summary,status,provider,model,reasoning_mode,plugin_ids,output_tail,output_sequence,bytes_seen,started_at,last_output_at,ended_at,exit_code,output_shared,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(200), 'terminals'),
    queryResult(vibeSupabase.from('dashboard_plugin_snapshots').select('user_id,device_id,plugin_id,label,kind,state,enabled,account_label,enabled_project_ids,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(200), 'plugin_snapshots'),
    queryResult(vibeSupabase.from('projects').select('id,name,description,workspace_id,metadata,created_at,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(200), 'projects'),
    queryResult(vibeSupabase.from('integrations').select('id,kind,label,enabled,updated_at').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(200), 'integrations'),
    queryResult(vibeSupabase.from('usage_log').select('ts,provider,model,prompt_tokens,completion_tokens,cost_usd,status,latency_ms').eq('user_id', user.id).gte('ts', lookback).order('ts', { ascending: false }).limit(1000), 'usage'),
    invokeUsageFunction('get-message-usage'), invokeUsageFunction('get-call-usage'), invokeUsageFunction('get-voice-usage'),
  ]);
  if (generation !== dashboardGeneration) return null;
  const byLabel = Object.fromEntries(results.map((result) => [result.label, result]));
  const devices = normalizeDevices(byLabel.devices.data || []);
  const terminals = normalizeTerminals(byLabel.terminals.data || [], devices);
  const pluginSnapshots = normalizePluginSnapshots(byLabel.plugin_snapshots.data || []);
  const integrations = normalizeIntegrations(byLabel.integrations.data || []);
  const plugins = mergePlugins(integrations, pluginSnapshots);
  const projects = normalizeProjects(byLabel.projects.data || [], terminals, plugins);
  const usage = aggregateUsage(byLabel.usage.data || []);
  const companyUsage = { message: byLabel['get-message-usage'].data, call: byLabel['get-call-usage'].data, voice: byLabel['get-voice-usage'].data };
  const errors = results.filter((result) => result.error).map((result) => ({ label: result.label, error: result.error }));
  return { profile: byLabel.profile.data, subscription: resolveSubscription(byLabel.subscription.data, byLabel.subscription.error), devices, terminals, projects, plugins, usage, companyUsage, errors, loadedAt: new Date().toISOString() };
}
async function refreshDashboard({ force = false } = {}) {
  if (!currentUser || !vibeSupabase) return;
  if (dashboardLoading) { refreshQueued = true; return; }
  dashboardLoading = true; refreshQueued = false;
  const generation = ++dashboardGeneration;
  if (force) setGlobalStatus('Refreshing live dashboard data…');
  try {
    const nextState = await loadDashboardData(currentUser, generation);
    if (!nextState || generation !== dashboardGeneration) return;
    dashboardState = nextState; renderDashboard();
    const criticalErrors = nextState.errors.filter(({ label }) => ['profile', 'subscription', 'devices', 'terminals'].includes(label));
    setGlobalStatus(criticalErrors.length ? 'Dashboard loaded, but some live data is temporarily unavailable.' : 'Dashboard is live.', criticalErrors.length ? 'warn' : 'good');
  } catch {
    if (generation === dashboardGeneration) setGlobalStatus('Dashboard data is temporarily unavailable. Existing values were kept.', 'error');
  } finally {
    if (generation === dashboardGeneration) dashboardLoading = false;
    if (refreshQueued && currentUser) void refreshDashboard();
  }
}
function setText(node, value) { node.textContent = value; }
function emptyState(title, detail) {
  const element = document.createElement('div'); element.className = 'empty-state';
  const strong = document.createElement('strong'); strong.textContent = title;
  const span = document.createElement('span'); span.textContent = detail;
  element.append(strong, span); return element;
}
function renderDashboard() {
  renderAccountIdentity(); renderSummary(); renderDevices(); renderOverviewTerminals(); renderHealth(); renderTerminalFilters(); renderTerminalWorkspace(); renderProjects(); renderPlugins(); renderUsage(); renderBilling();
  nodes.lastUpdated.textContent = dashboardState.loadedAt ? `Updated ${new Date(dashboardState.loadedAt).toLocaleTimeString()}` : 'Not updated yet';
}
function renderAccountIdentity() {
  const displayName = safeText(dashboardState.profile?.display_name, 80) || 'VibeSpace account';
  const email = currentUser?.email || '';
  nodes.accountName.textContent = displayName; nodes.accountEmail.textContent = email; nodes.accountAvatar.textContent = (displayName || email || 'V').charAt(0).toUpperCase();
}
function renderSummary() {
  const onlineDevices = dashboardState.devices.filter((device) => device.isOnline);
  const runningTerminals = dashboardState.terminals.filter((terminal) => ACTIVE_TERMINAL_STATUSES.has(terminal.status));
  const connectedPlugins = dashboardState.plugins.filter((plugin) => plugin.enabled && plugin.state === 'connected');
  const totalTokens = dashboardState.usage.inputTokens + dashboardState.usage.outputTokens;
  setText(nodes.summaryDevices, formatNumber(onlineDevices.length));
  setText(nodes.summaryDevicesDetail, dashboardState.devices.length ? `${dashboardState.devices.length} known device${dashboardState.devices.length === 1 ? '' : 's'}` : 'Waiting for desktop presence.');
  setText(nodes.summaryTerminals, formatNumber(runningTerminals.length));
  setText(nodes.summaryTerminalsDetail, dashboardState.terminals.length ? `${dashboardState.terminals.length} terminal snapshot${dashboardState.terminals.length === 1 ? '' : 's'} available` : 'No live terminal sessions.');
  setText(nodes.summaryProjects, formatNumber(dashboardState.projects.length));
  setText(nodes.summaryProjectsDetail, dashboardState.projects.length ? 'Projects from cloud sync and live terminals.' : 'No projects reported.');
  setText(nodes.summaryTokens, formatNumber(totalTokens));
  setText(nodes.summaryTokensDetail, `${dashboardState.usage.requests.toLocaleString()} recorded model request${dashboardState.usage.requests === 1 ? '' : 's'}`);
  setText(nodes.summaryPlugins, formatNumber(connectedPlugins.length));
  setText(nodes.summaryPluginsDetail, dashboardState.plugins.length ? `${dashboardState.plugins.length} connection record${dashboardState.plugins.length === 1 ? '' : 's'}` : 'No connection snapshots.');
  setText(nodes.summaryPlan, dashboardState.subscription.plan); setText(nodes.summaryPlanDetail, dashboardState.subscription.detail);
  setText(nodes.navTerminalCount, `${runningTerminals.length} live`); setText(nodes.navProjectCount, `${dashboardState.projects.length} projects`); setText(nodes.navPluginCount, `${connectedPlugins.length} connected`); setText(nodes.navPlanLabel, dashboardState.subscription.plan);
}
function renderDevices() {
  nodes.deviceList.replaceChildren();
  if (!dashboardState.devices.length) { nodes.deviceList.append(emptyState('No desktop has checked in yet', 'Sign into the updated VibeSpace desktop app. Its live publisher will appear here automatically.')); nodes.deviceFreshness.textContent = 'No signal'; return; }
  const freshest = dashboardState.devices[0];
  nodes.deviceFreshness.textContent = freshest?.lastSeenAt ? relativeTime(freshest.lastSeenAt) : 'Waiting';
  for (const device of dashboardState.devices) {
    const fragment = nodes.deviceTemplate.content.cloneNode(true);
    const dot = fragment.querySelector('[data-field="state-dot"]'); dot.classList.toggle('online', device.isOnline);
    fragment.querySelector('[data-field="state"]').textContent = device.isOnline ? 'Online' : 'Offline';
    fragment.querySelector('[data-field="name"]').textContent = `${device.displayName} · ${device.appVersion}`;
    fragment.querySelector('[data-field="runtime"]').textContent = device.activeRuntime || 'Runtime not reported';
    const terminalCount = dashboardState.terminals.filter((terminal) => terminal.deviceId === device.deviceId).length;
    const agentCount = dashboardState.terminals.filter((terminal) => terminal.deviceId === device.deviceId && terminal.agentSlug).length;
    fragment.querySelector('[data-field="terminals"]').textContent = String(terminalCount); fragment.querySelector('[data-field="agents"]').textContent = String(agentCount); fragment.querySelector('[data-field="last-seen"]').textContent = relativeTime(device.lastSeenAt);
    fragment.querySelector('[data-action="revoke"]').addEventListener('click', () => revokeDevice(device)); nodes.deviceList.append(fragment);
  }
}
async function revokeDevice(device) {
  if (!currentUser || !vibeSupabase) return;
  if (!window.confirm(`Revoke dashboard access for ${device.displayName}? The device must be re-authorized before it can publish again.`)) return;
  setGlobalStatus('Revoking device dashboard access…');
  try {
    const { data, error } = await vibeSupabase.rpc('revoke_live_dashboard_device', { p_expected_user_id: currentUser.id, p_device_id: device.deviceId });
    if (error || data !== true) throw error || new Error('revoke_failed');
    await refreshDashboard({ force: true });
  } catch { setGlobalStatus('That device could not be revoked. Try again.', 'error'); }
}
