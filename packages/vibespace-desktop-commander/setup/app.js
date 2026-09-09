const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
let state = { step: 1, status: 'disconnected', hasKey: false },
  step = 1,
  timer,
  saving = Promise.resolve(),
  busy = false;
const headers = { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' };
async function api(route, body) {
  const response = await fetch('/setup/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      response.status === 401
        ? 'Open Setup from VibeSpace again to securely resume.'
        : result.error || 'Unable to confirm the connection.',
    );
  return result;
}
function error(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function show() {
  for (const number of [1, 2, 3]) {
    $('step-' + number).hidden = step !== number;
    const item = document.querySelector(`[data-step="${number}"]`);
    item.className = number === step ? 'active' : number < step ? 'done' : '';
  }
  $('back').disabled = step === 1 || busy;
  $('next').hidden = step === 3;
  $('next').disabled = busy || (step === 2 && state.status !== 'ready');
  $('connect').disabled =
    !state.connectionDetected || busy || state.status === 'connecting' || state.status === 'ready';
  $('connect').textContent =
    state.status === 'connecting'
      ? 'Connecting…'
      : state.status === 'ready'
        ? 'Tunnel ready ✓'
        : 'Connect tunnel ↗';
  $('status').textContent = !state.connectionDetected
    ? 'Checking connection…'
    : state.status === 'ready'
      ? '● Tunnel ready'
      : state.status === 'connecting'
        ? 'Connecting to OpenAI…'
        : 'Progress saved on this computer';
  $('rail-status').textContent =
    state.status === 'ready'
      ? '●  Tunnel ready'
      : '○  ' + (state.status === 'connecting' ? 'Connecting' : 'Not connected');
  $('tools').textContent = state.connectionDetected
    ? `${state.toolCount ?? 0} tools detected · connection file found`
    : 'Detecting bundled tools…';
  $('key').placeholder = state.hasKey
    ? 'Runtime key saved securely · paste to replace'
    : 'Paste your runtime key';
  $('ready-title').textContent =
    state.status === 'ready' ? 'Your tunnel is ready.' : 'Waiting for tunnel readiness';
  $('ready-detail').textContent =
    state.status === 'ready'
      ? `${state.toolCount ?? 0} local tools available through your tunnel.`
      : 'Return to step 2 to reconnect.';
}
async function saveDraft() {
  const tunnelId = $('tunnel').value.trim(),
    apiKey = $('key').value.trim();
  if (tunnelId && !/^tunnel_[a-zA-Z0-9_-]{8,128}$/.test(tunnelId))
    throw Error('Enter the full tunnel ID from OpenAI.');
  const input = { tunnelId, step, ...(apiKey ? { apiKey } : {}) };
  const operation = saving.then(async () => {
    $('saved').textContent = 'Saving securely…';
    state = await api('draft', input);
    if ($('key').value.trim() === apiKey && apiKey) $('key').value = '';
    $('saved').textContent = 'Saved on this computer. You can close this page and resume later.';
    show();
  });
  saving = operation.catch(() => {});
  return operation;
}
for (const id of ['tunnel', 'key'])
  $(id).addEventListener('input', () => {
    clearTimeout(timer);
    error('');
    timer = setTimeout(() => {
      if (!/^tunnel_[a-zA-Z0-9_-]{8,128}$/.test($('tunnel').value.trim())) return;
      if ($('key').value && $('key').value.length < 20) return;
      void saveDraft().catch((reason) => error(reason.message));
    }, 450);
  });
$('next').onclick = async () => {
  step = Math.min(3, step + 1);
  show();
  try {
    await saveDraft();
  } catch (reason) {
    error(reason.message);
  }
};
$('back').onclick = () => {
  step = Math.max(1, step - 1);
  show();
  void saveDraft().catch((reason) => error(reason.message));
};
$('connect').onclick = async () => {
  busy = true;
  error('');
  show();
  try {
    await saveDraft();
    state = await api('connect', {});
  } catch (reason) {
    error(reason.message);
  } finally {
    busy = false;
    show();
  }
};
$('disconnect').onclick = async () => {
  try {
    state = await api('disconnect', {});
    step = 2;
    show();
  } catch (reason) {
    error(reason.message);
  }
};
window.addEventListener('pagehide', () => {
  clearTimeout(timer);
  const tunnelId = $('tunnel').value.trim(),
    apiKey = $('key').value.trim();
  if (token && (!tunnelId || /^tunnel_[a-zA-Z0-9_-]{8,128}$/.test(tunnelId))) {
    void fetch('/setup/draft', {
      method: 'POST',
      headers,
      keepalive: true,
      body: JSON.stringify({ step, tunnelId, ...(apiKey.length >= 20 ? { apiKey } : {}) }),
    }).catch(() => {});
  }
});
async function refresh(initial = false) {
  try {
    const next = await api('state');
    const becameReady = next.status === 'ready' && state.status !== 'ready';
    state = next;
    if (initial) {
      step = state.step;
      $('tunnel').value = state.tunnelId;
    }
    if (becameReady) step = 3;
    if (state.error) error(state.error);
    show();
  } catch (reason) {
    error(reason.message);
  }
}
show();
void refresh(true);
const poll = setInterval(() => {
  if (!document.hidden && !busy) void refresh();
}, 4000);
window.addEventListener('pagehide', () => clearInterval(poll));
