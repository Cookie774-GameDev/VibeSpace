import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as accountModel from '../account/account-model.mjs';

const { normalizeDesktopPresence } = accountModel;

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('website presence model ages stale rows offline and strips unknown content', () => {
  const now = Date.parse('2026-08-09T02:05:00.000Z');
  const devices = normalizeDesktopPresence(
    [
      {
        device_id: 'device_live',
        display_name: 'Main PC',
        app_version: '1.5.0',
        is_online: true,
        last_seen_at: '2026-08-09T02:04:10.000Z',
        active_terminals: [
          {
            id: 'pty_1',
            name: 'Builder terminal',
            status: 'active',
            raw_command: 'private command',
            output: 'private output',
          },
        ],
        active_chats: [{ id: 'chat_1', name: 'Planning', status: 'open', content: 'secret' }],
        active_agent_jobs: [{ id: 'agent_1', name: 'Builder', status: 'running' }],
        active_runtime: 'Ollama · llama3.2:latest',
        provider_usage: { ollama: { requests: 3 } },
        background_task_count: 1,
        recent_sync_at: '2026-08-09T02:04:00.000Z',
        revoked_at: null,
      },
      {
        device_id: 'device_stale',
        display_name: 'Laptop',
        app_version: '1.5.0',
        is_online: true,
        last_seen_at: '2026-08-09T01:30:00.000Z',
        active_terminals: [],
        active_chats: [],
        active_agent_jobs: [],
        provider_usage: {},
        background_task_count: 0,
        revoked_at: null,
      },
      {
        device_id: 'device_revoked',
        display_name: 'Old PC',
        app_version: '1.4.0',
        last_seen_at: '2026-08-09T02:04:50.000Z',
        revoked_at: '2026-08-09T02:04:55.000Z',
      },
    ],
    now,
  );

  assert.equal(devices.length, 2);
  assert.equal(devices[0].online, true);
  assert.equal(devices[1].online, false);
  assert.deepEqual(devices[0].terminals[0], {
    id: 'pty_1',
    name: 'Builder terminal',
    status: 'active',
  });
  assert.doesNotMatch(JSON.stringify(devices), /private command|private output|secret/iu);
});

test('account hub exposes real auth and account-scoped reads without remote control', async () => {
  const html = await readFile(new URL('../account/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../account/account.js', import.meta.url), 'utf8');

  assert.match(html, /id="signin-form"/u);
  assert.match(html, /id="otp-form"/u);
  assert.match(html, /id="device-list"/u);
  assert.match(script, /signInWithPassword/u);
  assert.match(script, /signInWithOtp/u);
  assert.match(script, /verifyOtp/u);
  assert.match(script, /detectSessionInUrl:\s*false/u);
  assert.match(script, /\.from\('desktop_presence'\)/u);
  assert.match(script, /\.from\('profiles'\)/u);
  assert.match(script, /\.from\('subscriptions'\)/u);
  assert.match(script, /\.from\('app_access_entitlements'\)/u);
  assert.match(script, /functions\.invoke\('get-message-usage'/u);
  assert.match(script, /setInterval\(refreshAccountHub,\s*30_000\)/u);
  assert.match(script, /onAuthStateChange[\s\S]+accountController\.transition/u);
  assert.match(script, /await transitionToCurrentAccount\(\)/u);
  assert.doesNotMatch(
    `${html}\n${script}`,
    /terminal_output|raw_command|chat_content|prompt_body|filesystem_path|service_role|sb_secret_/iu,
  );
  assert.doesNotMatch(script, /terminal_(?:spawn|write)|shell|execute_command|remote control/iu);
});

test('an account transition invalidates delayed reads from the previous account', async () => {
  assert.equal(typeof accountModel.createAccountTransitionController, 'function');
  const { createAccountTransitionController } = accountModel;
  const accountA = { id: 'account-a', email: 'a@example.test' };
  const accountB = { id: 'account-b', email: 'b@example.test' };
  const delayedA = deferred();
  const delayedB = deferred();
  let currentUser = accountA;
  const rendered = [];
  const prepared = [];

  const controller = createAccountTransitionController({
    prepare: () => prepared.push('clear-and-hide'),
    showSignedOut: () => rendered.push({ user: null }),
    getCurrentUser: async () => currentUser,
    load: (user) => (user.id === accountA.id ? delayedA.promise : delayedB.promise),
    render: (user, data) => rendered.push({ user: user.id, data }),
    fail: (error) => {
      throw error;
    },
  });

  const loadA = controller.transition(accountA);
  currentUser = accountB;
  const loadB = controller.transition(accountB);
  delayedB.resolve({ plan: 'pro' });
  await loadB;
  delayedA.resolve({ plan: 'ultra' });
  await loadA;

  assert.deepEqual(rendered, [{ user: accountB.id, data: { plan: 'pro' } }]);
  assert.deepEqual(prepared, ['clear-and-hide', 'clear-and-hide']);
});

test('paid plan labels require an error-free active subscription authority', () => {
  assert.equal(typeof accountModel.resolvePlanPresentation, 'function');
  const { resolvePlanPresentation } = accountModel;
  const staleProfile = { tier: 'ultra' };

  assert.deepEqual(
    resolvePlanPresentation({
      profile: staleProfile,
      subscription: null,
      subscriptionError: null,
    }),
    {
      value: 'Not confirmed',
      detail: 'No authoritative active subscription was returned.',
    },
  );
  assert.equal(
    resolvePlanPresentation({
      profile: staleProfile,
      subscription: { plan: 'ultra', status: 'active' },
      subscriptionError: new Error('read failed'),
    }).value,
    'Not confirmed',
  );
  assert.equal(
    resolvePlanPresentation({
      profile: staleProfile,
      subscription: { plan: 'ultra', status: 'past_due' },
      subscriptionError: null,
    }).value,
    'Not confirmed',
  );
  assert.equal(
    resolvePlanPresentation({
      profile: staleProfile,
      subscription: { plan: 'pro', status: 'trialing' },
      subscriptionError: null,
    }).value,
    'Pro',
  );
});

test('account auth secrets are consumed immediately and cleared on every transition', () => {
  assert.equal(typeof accountModel.takeSecretInput, 'function');
  assert.equal(typeof accountModel.clearAccountAuthSecrets, 'function');
  const passwordInput = { value: 'correct horse battery staple' };
  const otpInput = { value: '123456' };
  const otpCard = { hidden: false };

  assert.equal(accountModel.takeSecretInput(passwordInput), 'correct horse battery staple');
  assert.equal(passwordInput.value, '');

  accountModel.clearAccountAuthSecrets({ passwordInput, otpInput, otpCard });
  assert.equal(passwordInput.value, '');
  assert.equal(otpInput.value, '');
  assert.equal(otpCard.hidden, true);
});

test('device revocation binds the RPC to the account captured by the rendered device', async () => {
  assert.equal(typeof accountModel.revokeDesktopDevice, 'function');
  const calls = [];
  const client = {
    rpc(name, params) {
      calls.push({ name, params });
      return Promise.resolve({ data: true, error: null });
    },
  };

  const result = await accountModel.revokeDesktopDevice(
    client,
    '67c86772-5cf3-4f30-908a-f6507f54fe2b',
    'device_shared',
  );

  assert.equal(result, true);
  assert.deepEqual(calls, [
    {
      name: 'revoke_desktop_device',
      params: {
        p_expected_user_id: '67c86772-5cf3-4f30-908a-f6507f54fe2b',
        p_device_id: 'device_shared',
      },
    },
  ]);
});
