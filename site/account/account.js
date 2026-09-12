import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';
import {
  clearAccountAuthSecrets,
  createAccountTransitionController,
  normalizeDesktopPresence,
  revokeDesktopDevice,
  resolvePlanPresentation,
  takeSecretInput,
} from './account-model.mjs';

const gatewayOrigin = 'https://vibespace-mcp.combatonline02.workers.dev';
const statusNode = document.querySelector('#account-status');
const authView = document.querySelector('#auth-view');
const hubView = document.querySelector('#hub-view');
const otpCard = document.querySelector('#otp-card');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const otpInput = document.querySelector('#otp-code');
let supabase;
let accountController;
let refreshTimer;

function status(message) {
  statusNode.textContent = message;
}

function showSignedOut() {
  clearAccountAuthSecrets({ passwordInput, otpInput, otpCard });
  authView.hidden = false;
  hubView.hidden = true;
  status('Sign in to load your account-scoped VibeSpace data.');
}

function clearAccountDerivedView() {
  clearAccountAuthSecrets({ passwordInput, otpInput, otpCard });
  hubView.hidden = true;
  authView.hidden = true;
  document.querySelector('#account-email').textContent = 'VibeSpace account';
  document.querySelector('#plan-value').textContent = 'Not confirmed';
  document.querySelector('#plan-detail').textContent = 'Waiting for server authority.';
  document.querySelector('#access-value').textContent = 'Not confirmed';
  document.querySelector('#access-detail').textContent = 'Waiting for server authority.';
  document.querySelector('#usage-value').textContent = 'Not reported';
  document.querySelector('#usage-detail').textContent = 'Waiting for server authority.';
  document.querySelector('#device-count').textContent = '0';
  document.querySelector('#online-summary').textContent = 'No presence received yet.';
  document.querySelector('#sync-value').textContent = 'Not reported';
  document.querySelector('#device-list').replaceChildren();
  status('Loading account-scoped data…');
}

function showSignedIn(user) {
  authView.hidden = true;
  hubView.hidden = false;
  document.querySelector('#account-email').textContent = user.email || 'VibeSpace account';
}

function relativeTime(value) {
  if (!value) return 'Not reported';
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return new Date(value).toLocaleString();
}

function renderItems(list, items, emptyLabel) {
  list.replaceChildren();
  if (!items.length) {
    const item = document.createElement('li');
    item.textContent = emptyLabel;
    list.append(item);
    return;
  }
  items.forEach((entry) => {
    const item = document.createElement('li');
    item.textContent = `${entry.name} · ${entry.status}`;
    list.append(item);
  });
}

function renderDevices(devices, expectedUserId) {
  const container = document.querySelector('#device-list');
  const template = document.querySelector('#device-template');
  container.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('p');
    empty.textContent =
      'No desktop presence has been published yet. Open the signed-in VibeSpace desktop app.';
    container.append(empty);
  }

  devices.forEach((device) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector('[data-field="name"]').textContent =
      `${device.displayName} · ${device.appVersion}`;
    const state = fragment.querySelector('[data-field="state"]');
    state.textContent = device.online ? 'Online' : 'Offline';
    state.classList.toggle('offline', !device.online);
    fragment.querySelector('[data-field="last-seen"]').textContent =
      `Last seen ${relativeTime(device.lastSeenAt)}`;
    fragment.querySelector('[data-field="runtime"]').textContent =
      device.activeRuntime || 'Not reported';
    renderItems(fragment.querySelector('[data-list="terminals"]'), device.terminals, 'None open');
    renderItems(fragment.querySelector('[data-list="chats"]'), device.chats, 'None open');
    renderItems(fragment.querySelector('[data-list="agents"]'), device.agentJobs, 'None active');
    fragment.querySelector('[data-field="background"]').textContent =
      `${device.backgroundTaskCount} background task${device.backgroundTaskCount === 1 ? '' : 's'}`;
    const providerCount = Object.keys(device.providerUsage).length;
    fragment.querySelector('[data-field="usage"]').textContent = providerCount
      ? `${providerCount} provider usage summar${providerCount === 1 ? 'y' : 'ies'}`
      : 'Provider usage not reported';
    fragment.querySelector('[data-action="revoke"]').addEventListener('click', async () => {
      if (
        !window.confirm(
          `Stop showing ${device.displayName} in Account Hub? Future presence for this device ID will be rejected.`,
        )
      )
        return;
      status('Revoking device presence…');
      const revoked = await revokeDesktopDevice(supabase, expectedUserId, device.deviceId);
      if (!revoked) {
        status('Could not revoke that device.');
        return;
      }
      await refreshAccountHub();
    });
    container.append(fragment);
  });
}

async function loadAccountData(user) {
  const [profileResult, subscriptionResult, accessResult, usageResult, presenceResult] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('display_name,tier,monthly_quota')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('plan,status,current_period_end,cancel_at_period_end,updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('app_access_entitlements')
        .select(
          'status,provider_status,trial_ends_at,grace_ends_at,current_period_end,cancel_at_period_end,server_checked_at',
        )
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase.functions.invoke('get-message-usage', { body: {} }),
      supabase
        .from('desktop_presence')
        .select(
          'device_id,display_name,app_version,is_online,last_seen_at,active_terminals,active_chats,active_agent_jobs,active_runtime,provider_usage,background_task_count,recent_sync_at,revoked_at',
        )
        .eq('user_id', user.id)
        .order('last_seen_at', { ascending: false }),
    ]);
  return { profileResult, subscriptionResult, accessResult, usageResult, presenceResult };
}

function renderAccountHub(
  user,
  { profileResult, subscriptionResult, accessResult, usageResult, presenceResult },
) {
  showSignedIn(user);
  const access = accessResult.data;
  const plan = resolvePlanPresentation({
    subscription: subscriptionResult.data,
    subscriptionError: subscriptionResult.error,
  });
  document.querySelector('#plan-value').textContent = plan.value;
  document.querySelector('#plan-detail').textContent = plan.detail;
  document.querySelector('#access-value').textContent =
    !accessResult.error && access?.status
      ? String(access.status).replaceAll('_', ' ')
      : 'Not confirmed';
  const accessDeadline =
    access?.status === 'trialing'
      ? access.trial_ends_at
      : access?.status === 'grace'
        ? access.grace_ends_at
        : access?.current_period_end;
  document.querySelector('#access-detail').textContent =
    !accessResult.error && access
      ? `${access.provider_status || 'server-managed'}${
          access.cancel_at_period_end ? ' · cancels at period end' : ''
        }${accessDeadline ? ` · through ${new Date(accessDeadline).toLocaleString()}` : ''}`
      : 'No authoritative Access entitlement is available.';
  const usage = usageResult.data;
  const included = Number(usage?.credits_included);
  const used = Number(usage?.credits_used);
  document.querySelector('#usage-value').textContent =
    Number.isFinite(included) && Number.isFinite(used)
      ? `${used.toLocaleString()} / ${included.toLocaleString()} credits`
      : 'Not reported';
  const messageUsed = Number(usage?.message?.used);
  const callUsed = Number(usage?.call?.used);
  const smsUsed = Number(usage?.sms?.used);
  document.querySelector('#usage-detail').textContent = [messageUsed, callUsed, smsUsed].every(
    Number.isFinite,
  )
    ? `AI ${messageUsed.toLocaleString()} credits · voice ${callUsed.toLocaleString()} min · SMS ${smsUsed.toLocaleString()}`
    : 'Company credit breakdown is temporarily unavailable.';

  const devices = normalizeDesktopPresence(presenceResult.data || []);
  renderDevices(devices, user.id);
  document.querySelector('#device-count').textContent = String(devices.length);
  const onlineCount = devices.filter((device) => device.online).length;
  document.querySelector('#online-summary').textContent =
    `${onlineCount} online · ${devices.length - onlineCount} offline`;
  const syncTimes = devices
    .map((device) => device.recentSyncAt)
    .filter(Boolean)
    .sort();
  document.querySelector('#sync-value').textContent = relativeTime(syncTimes.at(-1));

  if (
    profileResult.error ||
    subscriptionResult.error ||
    accessResult.error ||
    usageResult.error ||
    presenceResult.error
  ) {
    status('Some account data is temporarily unavailable. Displayed values remain server-derived.');
  } else {
    status(`Updated ${new Date().toLocaleTimeString()}.`);
  }
}

async function currentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}

async function refreshAccountHub() {
  const user = await currentUser();
  if (!user) return accountController.transition(null);
  status('Refreshing server-confirmed account data…');
  return accountController.refresh(user);
}

async function transitionToCurrentAccount() {
  return accountController.transition(await currentUser());
}

async function initialize() {
  try {
    const response = await fetch(`${gatewayOrigin}/public-config`, {
      headers: { accept: 'application/json' },
      mode: 'cors',
    });
    if (!response.ok) throw new Error('Account authentication is unavailable.');
    const config = await response.json();
    if (
      !String(config.supabase_url).startsWith('https://') ||
      !String(config.supabase_publishable_key).startsWith('sb_publishable_')
    ) {
      throw new Error('Account authentication is not configured.');
    }
    supabase = createClient(config.supabase_url, config.supabase_publishable_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    accountController = createAccountTransitionController({
      prepare: clearAccountDerivedView,
      showSignedOut,
      getCurrentUser: currentUser,
      load: loadAccountData,
      render: renderAccountHub,
      fail: () => status('Account data is temporarily unavailable.'),
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      void accountController.transition(session?.user ?? null);
    });
    await accountController.transition(await currentUser());
    refreshTimer = setInterval(refreshAccountHub, 30_000);
  } catch (error) {
    status(error instanceof Error ? error.message : 'Account Hub is unavailable.');
    authView.hidden = true;
  }
}

document.querySelector('#signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  status('Signing in securely…');
  const email = emailInput.value.trim().toLowerCase();
  const password = takeSecretInput(passwordInput);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    status(error.message || 'Sign in failed.');
    return;
  }
  await transitionToCurrentAccount();
});

document.querySelector('#email-code-button').addEventListener('click', async () => {
  const email = emailInput.value.trim().toLowerCase();
  if (!email) {
    status('Enter your email first.');
    emailInput.focus();
    return;
  }
  status('Sending a one-time code…');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) {
    status(error.message || 'Could not send a code.');
    return;
  }
  otpCard.hidden = false;
  status('Check your inbox and spam folder for the 6-digit code.');
});

document.querySelector('#otp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim().toLowerCase();
  const token = takeSecretInput(otpInput).replace(/\D/gu, '').slice(0, 6);
  if (token.length !== 6) {
    status('Enter the complete 6-digit code.');
    return;
  }
  status('Verifying the one-time code…');
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) {
    status(error.message || 'The code is invalid or expired.');
    return;
  }
  await transitionToCurrentAccount();
});

document.querySelector('#refresh-button').addEventListener('click', refreshAccountHub);
document.querySelector('#signout-button').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    status(error.message || 'Sign out failed.');
    return;
  }
  await accountController.transition(null);
});

initialize();
