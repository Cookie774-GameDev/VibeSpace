const PRESENCE_TTL_MS = 120_000;
const ALLOWED_STATUS = new Set([
  'active',
  'idle',
  'open',
  'running',
  'queued',
  'blocked',
  'done',
  'failed',
  'stopped',
  'unknown',
]);
const AUTHORITATIVE_PLAN_STATUSES = new Set(['active', 'trialing', 'grace']);
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function takeSecretInput(input) {
  const value = String(input?.value ?? '');
  if (input) input.value = '';
  return value;
}

export function clearAccountAuthSecrets({ passwordInput, otpInput, otpCard }) {
  if (passwordInput) passwordInput.value = '';
  if (otpInput) otpInput.value = '';
  if (otpCard) otpCard.hidden = true;
}

export async function revokeDesktopDevice(client, expectedUserId, deviceId) {
  const normalizedUserId = String(expectedUserId ?? '').trim();
  if (!USER_ID.test(normalizedUserId)) return false;
  const { data, error } = await client.rpc('revoke_desktop_device', {
    p_expected_user_id: normalizedUserId,
    p_device_id: deviceId,
  });
  return !error && data === true;
}

export function createAccountTransitionController({
  prepare,
  showSignedOut,
  getCurrentUser,
  load,
  render,
  fail,
}) {
  let generation = 0;

  async function run(user, shouldPrepare) {
    const transitionGeneration = ++generation;
    if (shouldPrepare) prepare();
    if (!user) {
      showSignedOut();
      return false;
    }

    try {
      const data = await load(user);
      if (transitionGeneration !== generation) return false;
      const currentUser = await getCurrentUser();
      if (transitionGeneration !== generation || !currentUser || currentUser.id !== user.id) {
        return false;
      }
      render(user, data);
      return true;
    } catch (error) {
      if (transitionGeneration === generation) fail(error);
      return false;
    }
  }

  return {
    transition(user) {
      return run(user, true);
    },
    refresh(user) {
      return run(user, false);
    },
  };
}

export function resolvePlanPresentation({ subscription, subscriptionError }) {
  if (subscriptionError) {
    return {
      value: 'Not confirmed',
      detail: 'Subscription authority is temporarily unavailable.',
    };
  }
  if (!subscription) {
    return {
      value: 'Not confirmed',
      detail: 'No authoritative active subscription was returned.',
    };
  }

  const status = text(subscription.status, 40).toLowerCase();
  const plan = text(subscription.plan, 40).toLowerCase();
  if (!plan || !AUTHORITATIVE_PLAN_STATUSES.has(status)) {
    return {
      value: 'Not confirmed',
      detail: `Subscription status ${status || 'unknown'} is not active.`,
    };
  }

  return {
    value: plan.charAt(0).toUpperCase() + plan.slice(1),
    detail: `${status}${subscription.cancel_at_period_end ? ' · cancels at period end' : ''}${
      subscription.current_period_end
        ? ` · through ${new Date(subscription.current_period_end).toLocaleDateString()}`
        : ''
    }`,
  };
}

function text(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function items(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = text(item.id, 128);
    const name = text(item.name, 120);
    if (!id || !name) return [];
    const candidate = text(item.status, 24).toLowerCase();
    return [{ id, name, status: ALLOWED_STATUS.has(candidate) ? candidate : 'unknown' }];
  });
}

function usage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [provider, metrics] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/u.test(provider)) continue;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) continue;
    const clean = {};
    for (const [metric, amount] of Object.entries(metrics).slice(0, 12)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,39}$/u.test(metric)) continue;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
      clean[metric] = Math.max(0, Math.min(amount, 1_000_000_000));
    }
    result[provider] = clean;
  }
  return result;
}

export function normalizeDesktopPresence(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object' && !row.revoked_at)
    .map((row) => {
      const lastSeenMs = Date.parse(row.last_seen_at);
      return {
        deviceId: text(row.device_id, 128),
        displayName: text(row.display_name, 80) || 'VibeSpace desktop',
        appVersion: text(row.app_version, 40) || 'Unknown',
        online:
          row.is_online === true &&
          Number.isFinite(lastSeenMs) &&
          now - lastSeenMs >= 0 &&
          now - lastSeenMs <= PRESENCE_TTL_MS,
        lastSeenAt: Number.isFinite(lastSeenMs) ? new Date(lastSeenMs).toISOString() : null,
        terminals: items(row.active_terminals),
        chats: items(row.active_chats),
        agentJobs: items(row.active_agent_jobs),
        activeRuntime: text(row.active_runtime, 120) || null,
        providerUsage: usage(row.provider_usage),
        backgroundTaskCount: Math.max(
          0,
          Math.min(Math.trunc(Number(row.background_task_count) || 0), 1000),
        ),
        recentSyncAt: Number.isFinite(Date.parse(row.recent_sync_at))
          ? new Date(row.recent_sync_at).toISOString()
          : null,
      };
    })
    .filter((device) => device.deviceId)
    .sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return String(right.lastSeenAt).localeCompare(String(left.lastSeenAt));
    });
}
