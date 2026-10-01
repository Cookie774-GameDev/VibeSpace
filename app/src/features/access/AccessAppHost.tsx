import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { Button } from '@/components/ui/button';
import { SignInDialog } from '@/features/auth/SignInDialog';
import { DesktopPresencePublisher } from './DesktopPresencePublisher';
import { getSupabaseClient, type TypedSupabaseClient } from '@/lib/supabase/client';
import { openExternal } from '@/lib/tauri';
import { useAuthStore } from '@/stores/auth';
import {
  AccessGatewayError,
  createAccessGateway,
  type AccessGateway,
  type AccessGatewayTransport,
} from './accessGateway';
import { AccessHost } from './AccessHost';
import { AccessPaywall, type PendingAction } from './AccessPaywall';
import type { AccessViewModel } from './accessViewModel';
import {
  createInstalledAccessRuntime,
  InstalledAccessTransportUnavailableError,
} from './installedAccessRuntime';
import { backupCurrentAccountWorkspace } from './workspaceBackup';
import './sakura-access.css';

export interface AccessAppRuntime {
  loadViewModel(signal: AbortSignal): Promise<AccessViewModel>;
  createCheckoutUrl(signal?: AbortSignal): Promise<string>;
  createPortalUrl(signal?: AbortSignal): Promise<string>;
  openExternalUrl(url: string): Promise<void>;
  signOut(): Promise<void>;
  backupLocalData(): Promise<void>;
}

export interface AccessAppHostProps {
  children: React.ReactNode;
  enabled: boolean;
  runtime: AccessAppRuntime;
  privacyUrl?: string;
  termsUrl?: string;
}

const ACCESS_LOAD_ERROR = 'Access could not be verified. Check your connection and try again.';

function safeHttpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 2_048) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname === '' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const noop = () => undefined;

async function openAuthorizedExternalUrl(
  signal: AbortSignal,
  createUrl: () => Promise<string>,
  openUrl: (url: string) => Promise<void>,
) {
  const url = await createUrl();
  if (signal.aborted) return;
  await openUrl(url);
}

export function AccessAppHost({
  children,
  enabled,
  runtime,
  privacyUrl,
  termsUrl,
}: AccessAppHostProps) {
  const [viewModel, setViewModel] = React.useState<AccessViewModel | null>(null);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionNotice, setActionNotice] = React.useState<string | null>(null);
  const actionGeneration = React.useRef(0);
  const actionController = React.useRef<AbortController | null>(null);

  React.useEffect(
    () => () => {
      actionGeneration.current += 1;
      actionController.current?.abort();
    },
    [],
  );

  const loadAccess = React.useCallback(
    async (signal: AbortSignal) => {
      const next = await runtime.loadViewModel(signal);
      if (!signal.aborted) {
        setViewModel(next);
        setActionError(null);
      }
      return next.host;
    },
    [runtime],
  );

  const runAction = React.useCallback(
    async (
      action: PendingAction,
      operation: (signal: AbortSignal) => Promise<void>,
      errorMessage: string,
      refresh?: () => void,
      successMessage?: string,
    ) => {
      actionController.current?.abort();
      const controller = new AbortController();
      actionController.current = controller;
      const generation = ++actionGeneration.current;
      setPendingAction(action);
      setActionError(null);
      setActionNotice(null);
      try {
        await operation(controller.signal);
        if (!controller.signal.aborted && generation === actionGeneration.current) {
          if (successMessage) setActionNotice(successMessage);
          refresh?.();
        }
      } catch {
        if (!controller.signal.aborted && generation === actionGeneration.current) {
          setActionNotice(null);
          setActionError(errorMessage);
        }
      } finally {
        if (generation === actionGeneration.current) {
          actionController.current = null;
          setPendingAction(null);
        }
      }
    },
    [],
  );

  const openLegal = React.useCallback(
    (kind: 'privacy' | 'terms', configured: string | undefined) => {
      const url = safeHttpsUrl(configured);
      if (!url) {
        setActionError(
          `${kind === 'privacy' ? 'Privacy' : 'Terms'} link is not configured for this build.`,
        );
        return;
      }
      void runAction(
        null,
        () => runtime.openExternalUrl(url),
        `The ${kind} link could not be opened.`,
      );
    },
    [runAction, runtime],
  );

  const withActionNotice = (paywall: React.ReactNode) => (
    <>
      {actionNotice && (
        <div
          role="status"
          aria-live="polite"
          className="mc7f-access-app-host mx-auto mt-4 w-full max-w-lg rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-secondary text-success [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-success/50 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:shadow-none"
        >
          {actionNotice}
        </div>
      )}
      {paywall}
    </>
  );

  if (!enabled) return <>{children}</>;

  const recoveryPaywall = (refresh: () => void, error: string | null, loading: boolean) =>
    withActionNotice(
      <AccessPaywall
        displayState="unknown"
        featureTier={viewModel?.featureTier ?? 'unknown'}
        loading={loading}
        error={error}
        pendingAction={pendingAction}
        onContinue={noop}
        onSubscribe={noop}
        onManageBilling={() => {
          void runAction(
            'manage-billing',
            (signal) =>
              openAuthorizedExternalUrl(
                signal,
                () => runtime.createPortalUrl(signal),
                (url) => runtime.openExternalUrl(url),
              ),
            'Billing could not be opened. Please try again.',
          );
        }}
        onRestoreAccess={refresh}
        onSignOut={() => {
          void runAction(
            'sign-out',
            () => runtime.signOut(),
            'Sign out could not be completed. Please try again.',
            refresh,
          );
        }}
        onExportData={() => {
          void runAction(
            'export',
            () => runtime.backupLocalData(),
            'Local data could not be backed up. Please try again.',
            undefined,
            'Your backup file was created.',
          );
        }}
        onPrivacy={() => openLegal('privacy', privacyUrl)}
        onTerms={() => openLegal('terms', termsUrl)}
      />,
    );

  return (
    <AccessHost
      enabled
      loadAccess={loadAccess}
      loadingFallback={({ refresh }) => recoveryPaywall(refresh, actionError, true)}
      renderError={({ refresh }) =>
        recoveryPaywall(refresh, actionError ?? ACCESS_LOAD_ERROR, false)
      }
      renderBlocked={({ snapshot, refresh }) => {
        const model = viewModel?.host.capturedAt === snapshot.capturedAt ? viewModel : null;
        const projection = model?.paywall;

        const checkout = () =>
          runAction(
            'subscribe',
            (signal) =>
              openAuthorizedExternalUrl(
                signal,
                () => runtime.createCheckoutUrl(signal),
                (url) => runtime.openExternalUrl(url),
              ),
            'Checkout could not be opened. Please try again.',
          );
        const paywall = (
          <AccessPaywall
            displayState={projection?.displayState ?? snapshot.displayState}
            featureTier={projection?.featureTier ?? snapshot.featureTier}
            trialDaysRemaining={projection?.trialDaysRemaining}
            trialEndDate={projection?.trialEndDate}
            graceDaysRemaining={projection?.graceDaysRemaining}
            graceEndDate={projection?.graceEndDate}
            paidThroughDate={projection?.paidThroughDate}
            error={actionError}
            pendingAction={pendingAction}
            onContinue={refresh}
            onSubscribe={() => void checkout()}
            onManageBilling={() => {
              void runAction(
                'manage-billing',
                (signal) =>
                  openAuthorizedExternalUrl(
                    signal,
                    () => runtime.createPortalUrl(signal),
                    (url) => runtime.openExternalUrl(url),
                  ),
                'Billing could not be opened. Please try again.',
              );
            }}
            onRestoreAccess={() => {
              actionController.current?.abort();
              actionGeneration.current += 1;
              setPendingAction(null);
              setActionError(null);
              setActionNotice(null);
              refresh();
            }}
            onSignOut={() => {
              void runAction(
                'sign-out',
                () => runtime.signOut(),
                'Sign out could not be completed. Please try again.',
                refresh,
              );
            }}
            onExportData={() => {
              void runAction(
                'export',
                () => runtime.backupLocalData(),
                'Local data could not be backed up. Please try again.',
                undefined,
                'Your backup file was created.',
              );
            }}
            onPrivacy={() => openLegal('privacy', privacyUrl)}
            onTerms={() => openLegal('terms', termsUrl)}
          />
        );

        if (!model?.checkoutNeeded || snapshot.displayState !== 'locked') {
          return withActionNotice(paywall);
        }
        return (
          <>
            {withActionNotice(paywall)}
            <div className="mc7f-access-app-host mx-auto -mt-8 w-full max-w-lg px-4 pb-10">
              <Button
                type="button"
                variant="accent"
                size="lg"
                className="w-full"
                disabled={pendingAction !== null}
                onClick={() => void checkout()}
              >
                Subscribe to VibeSpace Access
              </Button>
            </div>
          </>
        );
      }}
    >
      {children}
    </AccessHost>
  );
}

type RpcRequest = PromiseLike<{ data: unknown; error: unknown }> & {
  abortSignal(signal: AbortSignal): RpcRequest;
};

const TRANSPORT_UNAVAILABLE_MARKER = 'access_transport_unavailable';
const NETWORK_FAILURE_MESSAGES = [
  'failed to fetch',
  'typeerror: failed to fetch',
  'load failed',
  'networkerror when attempting to fetch resource.',
] as const;

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isInstalledTransportUnavailable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof TypeError) {
    return NETWORK_FAILURE_MESSAGES.includes(
      error.message.trim().toLowerCase() as (typeof NETWORK_FAILURE_MESSAGES)[number],
    );
  }
  const record = errorRecord(error);
  if (!record || record.code !== '') return false;
  return [record.message, record.details].some(
    (value) =>
      typeof value === 'string' &&
      NETWORK_FAILURE_MESSAGES.includes(
        value.trim().toLowerCase() as (typeof NETWORK_FAILURE_MESSAGES)[number],
      ),
  );
}

function requireClient(): TypedSupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new Error('Access service is unavailable.');
  return client;
}

async function authenticatedClient(signal?: AbortSignal): Promise<TypedSupabaseClient> {
  const client = requireClient();
  const { data, error } = await client.auth.getSession();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (error || !data.session?.user.id) throw new Error('Authentication is required.');
  return client;
}

function createInstalledGateway(appVersion: string): AccessGateway {
  const transport: AccessGatewayTransport = {
    async rpc(fn, params, options) {
      const client = await authenticatedClient(options?.signal);
      const transportClient = client as unknown as {
        rpc(name: string, parameters: Record<string, unknown>): RpcRequest;
      };
      let request = transportClient.rpc(fn, params);
      if (options?.signal) request = request.abortSignal(options.signal);
      try {
        const result = await request;
        if (isInstalledTransportUnavailable(result.error)) {
          throw new Error(TRANSPORT_UNAVAILABLE_MARKER);
        }
        return result;
      } catch (error) {
        if (isInstalledTransportUnavailable(error)) {
          throw new Error(TRANSPORT_UNAVAILABLE_MARKER);
        }
        throw error;
      }
    },
    async invokeFunction(fn, options) {
      const client = await authenticatedClient(options.signal);
      return await client.functions.invoke(fn, {
        body: options.body,
        signal: options.signal,
      });
    },
  };
  return createAccessGateway({ transport, appVersion });
}

function createInstalledRuntime(
  featureTier: string,
  appVersion: string,
  publicKeyConfiguration: string | undefined,
): AccessAppRuntime {
  let gateway: AccessGateway | null = null;
  const accessGateway = () => {
    gateway ??= createInstalledGateway(appVersion);
    return gateway;
  };
  const installedAccess = createInstalledAccessRuntime({
    async getAccountId(signal) {
      const client = requireClient();
      const { data, error } = await client.auth.getSession();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const userId = data.session?.user.id;
      return error || typeof userId !== 'string' ? null : userId;
    },
    async checkOnline(signal) {
      try {
        return await accessGateway().checkAccess(signal);
      } catch (error) {
        if (
          error instanceof AccessGatewayError &&
          error.code === 'rpc_error' &&
          error.message === TRANSPORT_UNAVAILABLE_MARKER
        ) {
          throw new InstalledAccessTransportUnavailableError();
        }
        throw error;
      }
    },
    async requestLease(signal) {
      const client = await authenticatedClient(signal);
      const { data, error } = await client.functions.invoke('access-lease', {
        body: {},
        signal,
      });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error) throw new Error('Offline access lease is unavailable.');
      return data;
    },
    publicKeyConfiguration,
    featurePlan: {
      active: featureTier !== 'free',
      tier: featureTier,
    },
  });

  return {
    loadViewModel: installedAccess.loadViewModel,
    async createCheckoutUrl(signal) {
      return (await accessGateway().createCheckoutUrl(signal)).url;
    },
    async createPortalUrl(signal) {
      return (await accessGateway().createPortalUrl(signal)).url;
    },
    openExternalUrl: openExternal,
    async signOut() {
      const client = requireClient();
      const { error } = await client.auth.signOut();
      if (error) throw new Error('Sign out failed.');
    },
    async backupLocalData() {
      await backupCurrentAccountWorkspace();
    },
  };
}

interface AccessBuildEnvironment {
  readonly MODE?: string;
  readonly PROD?: boolean;
  readonly VITE_ACCESS_GATE_ENABLED?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_ACCESS_LEASE_PUBLIC_KEYS?: string;
  readonly VITE_PRIVACY_URL?: string;
  readonly VITE_TERMS_URL?: string;
}

export function isAccessGateEnabled(environment: AccessBuildEnvironment): boolean {
  if (environment.PROD === true || environment.MODE === 'production') return true;
  const configured = environment.VITE_ACCESS_GATE_ENABLED;
  return typeof configured === 'string' && configured.trim().toLowerCase() === 'true';
}

function publishInstalledCloudSession(session: Session | null): boolean {
  const userId = session?.user.id?.trim() ?? '';
  const authState = useAuthStore.getState();
  const previousUserId = authState.cloudSession?.user_id.trim() ?? '';
  if (!userId) {
    if (authState.cloudSession !== null || authState.plan !== 'free') {
      useAuthStore.setState({ cloudSession: null, plan: 'free' });
    }
    return false;
  }
  useAuthStore.setState({
    cloudSession: {
      user_id: userId,
      email: session?.user.email ?? '',
      expires_at: session?.expires_at ?? 0,
    },
    ...(previousUserId && previousUserId !== userId ? { plan: 'free' as const } : {}),
  });
  return true;
}

function InstalledCloudAuthentication({
  configured,
  onSignIn,
  onCreateAccount,
}: {
  configured: boolean;
  onSignIn: () => void;
  onCreateAccount: () => void;
}) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const focused = React.useRef(false);

  React.useLayoutEffect(() => {
    if (focused.current) return;
    focused.current = true;
    headingRef.current?.focus();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <section className="w-full max-w-md rounded-3xl border border-border/80 bg-elevated p-7 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-copper">
          VibeSpace Access
        </p>
        <h1 ref={headingRef} tabIndex={-1} className="mt-3 text-2xl font-semibold text-foreground">
          Sign in to VibeSpace
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Sign in or create an account before VibeSpace verifies your trial or subscription.
        </p>
        {!configured ? (
          <p
            className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100"
            role="alert"
          >
            Cloud authentication is not configured in this build. Install the official release or
            contact VibeSpace support.
          </p>
        ) : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button type="button" onClick={onSignIn}>
            Sign in
          </Button>
          <Button type="button" variant="outline" onClick={onCreateAccount}>
            Create account
          </Button>
        </div>
      </section>
    </main>
  );
}

export function InstalledAccessAppHost({
  children,
  authenticatedBoundary: AuthenticatedBoundary,
}: React.PropsWithChildren<{
  authenticatedBoundary?: React.ComponentType<React.PropsWithChildren>;
}>) {
  const featureTier = useAuthStore((state) => state.plan);
  const cloudUserId = useAuthStore((state) => state.cloudSession?.user_id.trim() ?? '');
  const environment = import.meta.env as AccessBuildEnvironment;
  const accessGateEnabled = isAccessGateEnabled(environment);
  const appVersion = environment.VITE_APP_VERSION?.trim() || '0.0.0';
  const publicKeyConfiguration = environment.VITE_ACCESS_LEASE_PUBLIC_KEYS;
  const cloudConfigured = getSupabaseClient() !== null;
  const [authReady, setAuthReady] = React.useState(!accessGateEnabled);
  const [hasCloudSession, setHasCloudSession] = React.useState(false);
  const [signInOpen, setSignInOpen] = React.useState(false);
  const [signInMode, setSignInMode] = React.useState<'signin' | 'signup'>('signin');
  const runtime = React.useMemo(
    () => createInstalledRuntime(featureTier, appVersion, publicKeyConfiguration),
    [appVersion, cloudUserId, featureTier, publicKeyConfiguration],
  );

  React.useEffect(() => {
    if (!accessGateEnabled) {
      setAuthReady(true);
      return undefined;
    }

    const client = getSupabaseClient();
    if (!client) {
      publishInstalledCloudSession(null);
      setHasCloudSession(false);
      setAuthReady(true);
      return undefined;
    }

    let active = true;
    let authGeneration = 0;
    const publish = (session: Session | null) => {
      if (!active) return;
      setHasCloudSession(publishInstalledCloudSession(session));
      setAuthReady(true);
    };

    const bootstrapGeneration = authGeneration;
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (bootstrapGeneration !== authGeneration) return;
        publish(error ? null : data.session);
      })
      .catch(() => {
        if (bootstrapGeneration === authGeneration) publish(null);
      });

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      authGeneration += 1;
      publish(session);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [accessGateEnabled]);

  const openAuthentication = (mode: 'signin' | 'signup') => {
    setSignInMode(mode);
    setSignInOpen(true);
  };

  if (accessGateEnabled && !authReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Checking your VibeSpace session…
        </p>
      </main>
    );
  }

  if (accessGateEnabled && !hasCloudSession) {
    return (
      <>
        <InstalledCloudAuthentication
          configured={cloudConfigured}
          onSignIn={() => openAuthentication('signin')}
          onCreateAccount={() => openAuthentication('signup')}
        />
        <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} initialMode={signInMode} />
      </>
    );
  }

  const protectedWorkspace = accessGateEnabled ? (
    <AccessAppHost
      key={cloudUserId}
      enabled
      runtime={runtime}
      privacyUrl={safeHttpsUrl(environment.VITE_PRIVACY_URL)}
      termsUrl={safeHttpsUrl(environment.VITE_TERMS_URL)}
    >
      {children}
    </AccessAppHost>
  ) : (
    children
  );

  return (
    <>
      <DesktopPresencePublisher appVersion={appVersion} />
      {AuthenticatedBoundary ? (
        <AuthenticatedBoundary>{protectedWorkspace}</AuthenticatedBoundary>
      ) : (
        protectedWorkspace
      )}
    </>
  );
}
