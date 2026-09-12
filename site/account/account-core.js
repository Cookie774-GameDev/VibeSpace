const createClient = window.vibeCreateClient;
const GATEWAY_ORIGIN = 'https://vibespace-mcp.combatonline02.workers.dev';
const FALLBACK_REFRESH_MS = 5_000;
const REALTIME_REFRESH_DEBOUNCE_MS = 180;
const USAGE_LOOKBACK_DAYS = 31;
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ACTIVE_TERMINAL_STATUSES = new Set(['running', 'active', 'queued']);

const nodes = Object.freeze({
  globalStatus: document.querySelector('#global-status'),
  authView: document.querySelector('#auth-view'),
  dashboardView: document.querySelector('#dashboard-view'),
  authTabs: [...document.querySelectorAll('[data-auth-mode]')],
  credentialsPanel: document.querySelector('#auth-credentials-panel'),
  codePanel: document.querySelector('#auth-code-panel'),
  passwordPanel: document.querySelector('#auth-password-panel'),
  authEyebrow: document.querySelector('#auth-eyebrow'),
  authFormTitle: document.querySelector('#auth-form-title'),
  authFormDescription: document.querySelector('#auth-form-description'),
  credentialsForm: document.querySelector('#credentials-form'),
  displayNameField: document.querySelector('#display-name-field'),
  displayNameInput: document.querySelector('#display-name'),
  emailInput: document.querySelector('#email'),
  passwordField: document.querySelector('#password-field'),
  passwordInput: document.querySelector('#password'),
  passwordHelp: document.querySelector('#password-help'),
  confirmPasswordField: document.querySelector('#confirm-password-field'),
  confirmPasswordInput: document.querySelector('#confirm-password'),
  credentialsSubmit: document.querySelector('#credentials-submit'),
  emailCodeButton: document.querySelector('#email-code-button'),
  authError: document.querySelector('#auth-error'),
  authInfo: document.querySelector('#auth-info'),
  codeForm: document.querySelector('#code-form'),
  codeDescription: document.querySelector('#code-description'),
  otpInput: document.querySelector('#otp-code'),
  codeError: document.querySelector('#code-error'),
  codeInfo: document.querySelector('#code-info'),
  codeSubmit: document.querySelector('#code-submit'),
  resendCodeButton: document.querySelector('#resend-code-button'),
  codeBackButton: document.querySelector('#code-back-button'),
  newPasswordForm: document.querySelector('#new-password-form'),
  newPasswordInput: document.querySelector('#new-password'),
  newPasswordConfirmInput: document.querySelector('#new-password-confirm'),
  newPasswordError: document.querySelector('#new-password-error'),
  passwordBackButton: document.querySelector('#password-back-button'),
  accountAvatar: document.querySelector('#account-avatar'),
  accountName: document.querySelector('#account-name'),
  accountEmail: document.querySelector('#account-email'),
  dashboardNav: [...document.querySelectorAll('[data-dashboard-route]')],
  dashboardPanels: [...document.querySelectorAll('[data-route-panel]')],
  dashboardEyebrow: document.querySelector('#dashboard-eyebrow'),
  dashboardTitle: document.querySelector('#dashboard-title'),
  dashboardSubtitle: document.querySelector('#dashboard-subtitle'),
  lastUpdated: document.querySelector('#last-updated'),
  realtimeDot: document.querySelector('#realtime-dot'),
  realtimeLabel: document.querySelector('#realtime-label'),
  refreshButton: document.querySelector('#refresh-button'),
  signoutButton: document.querySelector('#signout-button'),
  navTerminalCount: document.querySelector('#nav-terminal-count'),
  navProjectCount: document.querySelector('#nav-project-count'),
  navPluginCount: document.querySelector('#nav-plugin-count'),
  navPlanLabel: document.querySelector('#nav-plan-label'),
  summaryDevices: document.querySelector('#summary-devices'),
  summaryDevicesDetail: document.querySelector('#summary-devices-detail'),
  summaryTerminals: document.querySelector('#summary-terminals'),
  summaryTerminalsDetail: document.querySelector('#summary-terminals-detail'),
  summaryProjects: document.querySelector('#summary-projects'),
  summaryProjectsDetail: document.querySelector('#summary-projects-detail'),
  summaryTokens: document.querySelector('#summary-tokens'),
  summaryTokensDetail: document.querySelector('#summary-tokens-detail'),
  summaryPlugins: document.querySelector('#summary-plugins'),
  summaryPluginsDetail: document.querySelector('#summary-plugins-detail'),
  summaryPlan: document.querySelector('#summary-plan'),
  summaryPlanDetail: document.querySelector('#summary-plan-detail'),
  deviceFreshness: document.querySelector('#device-freshness'),
  deviceList: document.querySelector('#device-list'),
  overviewTerminalList: document.querySelector('#overview-terminal-list'),
  healthList: document.querySelector('#health-list'),
  deviceTemplate: document.querySelector('#device-template'),
  terminalCardTemplate: document.querySelector('#terminal-card-template'),
  projectTemplate: document.querySelector('#project-template'),
  pluginTemplate: document.querySelector('#plugin-template'),
  terminalSearch: document.querySelector('#terminal-search'),
  terminalStatusFilter: document.querySelector('#terminal-status-filter'),
  terminalDeviceFilter: document.querySelector('#terminal-device-filter'),
  terminalProjectFilter: document.querySelector('#terminal-project-filter'),
  terminalGrid: document.querySelector('#terminal-grid'),
  terminalDetail: document.querySelector('#terminal-detail'),
  projectGrid: document.querySelector('#project-grid'),
  pluginGrid: document.querySelector('#plugin-grid'),
  usageInputTokens: document.querySelector('#usage-input-tokens'),
  usageOutputTokens: document.querySelector('#usage-output-tokens'),
  usageCost: document.querySelector('#usage-cost'),
  usageLatency: document.querySelector('#usage-latency'),
  usageTableBody: document.querySelector('#usage-table-body'),
  companyUsage: document.querySelector('#company-usage'),
  billingPlanName: document.querySelector('#billing-plan-name'),
  billingPlanStatus: document.querySelector('#billing-plan-status'),
  billingStatus: document.querySelector('#billing-status'),
  billingPeriod: document.querySelector('#billing-period'),
  billingCancel: document.querySelector('#billing-cancel'),
  billingCredits: document.querySelector('#billing-credits'),
  manageBillingButton: document.querySelector('#manage-billing-button'),
  billingMessage: document.querySelector('#billing-message'),
});

const routeCopy = Object.freeze({
  overview: {
    eyebrow: 'Dashboard',
    title: 'Overview',
    subtitle: 'Everything your VibeSpace desktop is reporting right now.',
  },
  terminals: {
    eyebrow: 'Live workspace',
    title: 'Terminals',
    subtitle: 'Inspect safe output tails, model details, uptime, projects, and plugin use.',
  },
  projects: {
    eyebrow: 'Connected work',
    title: 'Projects',
    subtitle: 'See every project, its live terminals, agents, models, and plugins.',
  },
  plugins: {
    eyebrow: 'Integrations',
    title: 'Plugins',
    subtitle: 'Review connection state and project access without exposing credentials.',
  },
  usage: {
    eyebrow: 'Usage',
    title: 'Models and credits',
    subtitle: 'Review locally recorded model activity and company-plan usage.',
  },
  billing: {
    eyebrow: 'Billing',
    title: 'Subscription',
    subtitle: 'Server-confirmed subscription state and Stripe billing management.',
  },
});

let vibeSupabase = null;
let currentUser = null;
let authMode = 'signin';
let pendingVerification = null;
let recoveryVerified = false;
let recoverySessionLocked = false;
let authGeneration = 0;
let dashboardGeneration = 0;
let dashboardLoading = false;
let refreshQueued = false;
let refreshTimer = null;
let realtimeChannel = null;
let realtimeDebounceTimer = null;
let selectedTerminalKey = null;
let dashboardState = emptyDashboardState();

function emptyDashboardState() {
  return {
    profile: null,
    subscription: resolveSubscription(null),
    devices: [],
    terminals: [],
    projects: [],
    plugins: [],
    usage: aggregateUsage([]),
    companyUsage: {},
    errors: [],
    loadedAt: null,
  };
}

function setGlobalStatus(message, tone = 'neutral') {
  nodes.globalStatus.textContent = message;
  nodes.globalStatus.dataset.tone = tone;
}

function setMessage(node, message) {
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function setBusy(buttons, busy) {
  for (const button of buttons) button.disabled = busy;
}

function clearSecretInputs() {
  nodes.passwordInput.value = '';
  nodes.confirmPasswordInput.value = '';
  nodes.otpInput.value = '';
  nodes.newPasswordInput.value = '';
  nodes.newPasswordConfirmInput.value = '';
}

function normalizedEmail() {
  return nodes.emailInput.value.trim().toLowerCase();
}

function validateEmail(email) {
  return EMAIL_PATTERN.test(email) ? null : 'Enter a valid email address.';
}

function validatePassword(password) {
  return PASSWORD_PATTERN.test(password)
    ? null
    : 'Use at least 8 characters with a letter and a number.';
}

function friendlyAuthError(error, fallback = 'The request could not be completed. Try again.') {
  const message = safeText(error?.message, 300).toLowerCase();
  if (message.includes('invalid login credentials')) return 'The email or password is incorrect.';
  if (message.includes('email not confirmed')) return 'Confirm your email with the code we sent before signing in.';
  if (message.includes('rate limit') || message.includes('too many')) return 'Too many attempts. Wait a moment and try again.';
  if (message.includes('expired')) return 'That code expired. Request a new one.';
  if (message.includes('invalid') && message.includes('token')) return 'That code is invalid or expired.';
  if (message.includes('already registered') || message.includes('already been registered')) {
    return 'That account may already exist. Try signing in or reset the password.';
  }
  if (message.includes('password')) return safeText(error?.message, 240) || fallback;
  return fallback;
}

function showAuthPanel(panel) {
  nodes.credentialsPanel.hidden = panel !== 'credentials';
  nodes.codePanel.hidden = panel !== 'code';
  nodes.passwordPanel.hidden = panel !== 'password';
}

function selectAuthMode(mode, { preserveEmail = false } = {}) {
  if (!['signin', 'signup', 'recovery'].includes(mode)) return;
  if (recoverySessionLocked) {
    recoverySessionLocked = false;
    if (vibeSupabase) void vibeSupabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }
  authGeneration += 1;
  authMode = mode;
  pendingVerification = null;
  recoveryVerified = false;
  showAuthPanel('credentials');
  setMessage(nodes.authError, '');
  setMessage(nodes.authInfo, '');
  setMessage(nodes.codeError, '');
  setMessage(nodes.codeInfo, '');
  setMessage(nodes.newPasswordError, '');
  clearSecretInputs();
  if (!preserveEmail) {
    nodes.emailInput.value = '';
    nodes.displayNameInput.value = '';
  }

  for (const tab of nodes.authTabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.authMode === mode));
  }

  const signup = mode === 'signup';
  const recovery = mode === 'recovery';
  nodes.displayNameField.hidden = !signup;
  nodes.passwordField.hidden = recovery;
  nodes.confirmPasswordField.hidden = !signup;
  nodes.passwordHelp.hidden = !signup;
  nodes.emailCodeButton.hidden = mode !== 'signin';
  nodes.passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
  nodes.passwordInput.required = !recovery;
  nodes.confirmPasswordInput.required = signup;

  if (signup) {
    nodes.authEyebrow.textContent = 'New VibeSpace account';
    nodes.authFormTitle.textContent = 'Create your account';
    nodes.authFormDescription.textContent = 'Choose a password, then verify your email with a 6-digit code.';
    nodes.credentialsSubmit.textContent = 'Create account';
  } else if (recovery) {
    nodes.authEyebrow.textContent = 'Account recovery';
    nodes.authFormTitle.textContent = 'Reset your password';
    nodes.authFormDescription.textContent = 'We will email a one-time 6-digit recovery code.';
    nodes.credentialsSubmit.textContent = 'Send recovery code';
  } else {
    nodes.authEyebrow.textContent = 'Welcome back';
    nodes.authFormTitle.textContent = 'Sign in to your dashboard';
    nodes.authFormDescription.textContent = 'Use your VibeSpace email and password.';
    nodes.credentialsSubmit.textContent = 'Sign in';
  }
}

function showSignedOut() {
  recoverySessionLocked = false;
  teardownDashboardRuntime();
  currentUser = null;
  dashboardState = emptyDashboardState();
  nodes.dashboardView.hidden = true;
  nodes.authView.hidden = false;
  selectAuthMode('signin');
  setGlobalStatus('Sign in or create an account to open your VibeSpace dashboard.');
}

function showCodePanel(type, email) {
  pendingVerification = { type, email };
  showAuthPanel('code');
  nodes.otpInput.value = '';
  setMessage(nodes.codeError, '');
  setMessage(nodes.codeInfo, '');
  const action =
    type === 'signup'
      ? 'finish creating your account'
      : type === 'recovery'
        ? 'verify password recovery'
        : 'sign in';
  nodes.codeDescription.textContent = `Enter the 6-digit code sent to ${email} to ${action}.`;
  nodes.codeSubmit.textContent = type === 'recovery' ? 'Verify recovery code' : 'Verify code';
  queueMicrotask(() => nodes.otpInput.focus());
}

async function cleanupUnexpectedSession(expectedEmail) {
  try {
    const { data } = await vibeSupabase.auth.getUser();
    const email = data?.user?.email?.trim().toLowerCase();
    if (email && email !== expectedEmail) await vibeSupabase.auth.signOut({ scope: 'local' });
  } catch {
    // Cleanup is best effort and must never reveal session details.
  }
}
