import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';

const gatewayOrigin = 'https://vibespace-mcp.combatonline02.workers.dev';
const authorizationId = new URLSearchParams(window.location.search).get('authorization_id');

const views = {
  loading: document.querySelector('#loading-view'),
  signin: document.querySelector('#signin-view'),
  consent: document.querySelector('#consent-view'),
  error: document.querySelector('#error-view'),
};
const status = document.querySelector('#form-status');
let supabase;

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

function setStatus(message) {
  status.textContent = message;
}

function showError(message) {
  document.querySelector('#error-message').textContent = message;
  setStatus('');
  showView('error');
}

function safeRedirect(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('The authorization server returned an unsafe redirect.');
  }
  window.location.assign(url.toString());
}

async function loadAuthorization() {
  if (!authorizationId || authorizationId.length > 512) {
    showError('The authorization request is missing or invalid.');
    return;
  }

  showView('loading');
  setStatus('');
  try {
    const configResponse = await fetch(`${gatewayOrigin}/public-config`, {
      headers: { accept: 'application/json' },
      mode: 'cors',
    });
    if (!configResponse.ok) throw new Error('VibeSpace MCP is not available yet.');
    const config = await configResponse.json();
    if (
      !String(config.supabase_url).startsWith('https://') ||
      !String(config.supabase_publishable_key).startsWith('sb_publishable_')
    ) {
      throw new Error('VibeSpace authentication is not configured.');
    }
    supabase = createClient(config.supabase_url, config.supabase_publishable_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      showView('signin');
      return;
    }

    const { data: details, error } =
      await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !details) {
      throw new Error(error?.message || 'This authorization request is invalid or expired.');
    }
    if (!('authorization_id' in details)) {
      safeRedirect(details.redirect_url);
      return;
    }

    document.querySelector('#client-name').textContent = details.client?.name || 'An application';
    document.querySelector('#redirect-uri').textContent = details.redirect_uri;
    const scopeList = document.querySelector('#scope-list');
    scopeList.replaceChildren();
    const scopes = String(details.scope || '')
      .split(/\s+/u)
      .filter(Boolean);
    (scopes.length ? scopes : ['Basic account identity']).forEach((scope) => {
      const item = document.createElement('li');
      item.textContent = scope;
      scopeList.append(item);
    });
    showView('consent');
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The authorization request failed.');
  }
}

document.querySelector('#signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Signing in securely…');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await loadAuthorization();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Sign in failed.');
  } finally {
    submit.disabled = false;
  }
});

async function decide(action) {
  setStatus(action === 'approve' ? 'Connecting securely…' : 'Canceling…');
  document.querySelector('#approve-button').disabled = true;
  document.querySelector('#deny-button').disabled = true;
  try {
    const operation =
      action === 'approve'
        ? supabase.auth.oauth.approveAuthorization(authorizationId)
        : supabase.auth.oauth.denyAuthorization(authorizationId);
    const { data, error } = await operation;
    if (error || !data?.redirect_url) {
      throw new Error(error?.message || 'The authorization decision failed.');
    }
    safeRedirect(data.redirect_url);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The authorization decision failed.');
  }
}

document.querySelector('#approve-button').addEventListener('click', () => decide('approve'));
document.querySelector('#deny-button').addEventListener('click', () => decide('deny'));
document.querySelector('#retry-button').addEventListener('click', loadAuthorization);

loadAuthorization();
