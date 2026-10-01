import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as AppModule from './App';
import {
  MonochromeFixtureController,
  resolveSettingsModalInitialTab,
  RuntimeProfileHandshakeGate,
} from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/ui/toast';
import { SettingsModal } from './features/settings/SettingsModal';
import * as settingsTabMemory from './features/settings/settingsTabMemory';
import { useAuthStore } from './stores/auth';
import { useUIStore } from './stores/ui';
import {
  MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
  MONOCHROME_EVIDENCE_SCHEMA_VERSION,
  MONOCHROME_VISUAL_TEST,
  resolveRuntimePlan,
  type MonochromeEvidenceCommit,
  type MonochromeFixtureRequest,
  type RuntimeProfileEvidence,
  type RuntimeProfileQuery,
} from './lib/runtimeProfile';

class TestErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <output data-testid="failure" /> : this.props.children;
  }
}

function deferredEvidence() {
  let resolve!: (value: RuntimeProfileEvidence) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<RuntimeProfileEvidence>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ordinaryPlan = resolveRuntimePlan(undefined);
const visualPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);
const visualExpectation = {
  appIdentifier: 'ai.vibespace.monochrome.testdeadbeef',
  capabilityIdentifier: 'monochrome-test' as const,
  sessionNonceHash: 'a'.repeat(64),
};

describe('App runtime-profile boundary behavior', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.runtimeProfileHandshake;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('mounts no product child or child effect while native evidence is pending', () => {
    const pending = deferredEvidence();
    const query = vi.fn(() => pending.promise);
    const childEffect = vi.fn();
    function Child() {
      childEffect();
      React.useEffect(childEffect, []);
      return <output data-testid="product" />;
    }
    const mounted = render(
      <RuntimeProfileHandshakeGate
        plan={ordinaryPlan}
        expectation={undefined}
        query={query}
        nativeRuntime
      >
        <Child />
      </RuntimeProfileHandshakeGate>,
    );
    expect(mounted.queryByTestId('product')).toBeNull();
    expect(mounted.getByRole('status').textContent).toContain('Verifying');
    expect(childEffect).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('releases product mounts only after valid ordinary native evidence', async () => {
    const pending = deferredEvidence();
    const effect = vi.fn();
    const mounted = render(
      <RuntimeProfileHandshakeGate
        plan={ordinaryPlan}
        expectation={undefined}
        query={() => pending.promise}
        nativeRuntime
      >
        <EffectChild effect={effect} />
      </RuntimeProfileHandshakeGate>,
    );
    await act(async () =>
      pending.resolve({
        profile: 'ordinary',
        appIdentifier: 'ai.jarvis.desktop',
        capabilityIdentifier: null,
        sessionNonceHash: null,
      }),
    );
    expect(mounted.getByTestId('product')).toBeTruthy();
    expect(effect).toHaveBeenCalledOnce();
  });

  it.each(['rejection', 'mismatch'] as const)(
    'keeps product mounts at zero on native %s',
    async (failure) => {
      const pending = deferredEvidence();
      const effect = vi.fn();
      const mounted = render(
        <TestErrorBoundary>
          <RuntimeProfileHandshakeGate
            plan={visualPlan}
            expectation={visualExpectation}
            query={() => pending.promise}
            nativeRuntime
          >
            <EffectChild effect={effect} />
          </RuntimeProfileHandshakeGate>
        </TestErrorBoundary>,
      );
      await act(async () => {
        if (failure === 'rejection') pending.reject(new Error('secret\r\n\u001b[31m'));
        else
          pending.resolve({
            profile: 'ordinary',
            appIdentifier: 'ai.vibespace',
            capabilityIdentifier: null,
            sessionNonceHash: null,
          });
      });
      expect(mounted.getByTestId('failure')).toBeTruthy();
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it('bypasses the native query only for an explicitly non-native browser runtime', () => {
    const query: RuntimeProfileQuery = vi.fn();
    const mounted = render(
      <RuntimeProfileHandshakeGate
        plan={ordinaryPlan}
        expectation={undefined}
        query={query}
        nativeRuntime={false}
      >
        <output data-testid="product" />
      </RuntimeProfileHandshakeGate>,
    );
    expect(mounted.getByTestId('product')).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it('marks validated visual browser readiness and removes the marker on cleanup', () => {
    const mounted = render(
      <RuntimeProfileHandshakeGate
        plan={visualPlan}
        expectation={visualExpectation}
        nativeRuntime={false}
      >
        <output />
      </RuntimeProfileHandshakeGate>,
    );
    expect(document.documentElement.dataset.runtimeProfileHandshake).toBe('ready');
    mounted.unmount();
    expect(document.documentElement.dataset.runtimeProfileHandshake).toBeUndefined();
  });

  it('shares one stable query promise across StrictMode effect replay', async () => {
    const query = vi.fn(async () => ({
      profile: 'ordinary',
      appIdentifier: 'ai.jarvis.desktop',
      capabilityIdentifier: null,
      sessionNonceHash: null,
    }));
    render(
      <React.StrictMode>
        <RuntimeProfileHandshakeGate
          plan={ordinaryPlan}
          expectation={undefined}
          query={query}
          nativeRuntime
        >
          <output />
        </RuntimeProfileHandshakeGate>
      </React.StrictMode>,
    );
    await act(async () => undefined);
    expect(query).toHaveBeenCalledOnce();
  });

  it('evicts only a rejected shared handshake so a boundary remount performs a fresh query', async () => {
    const productEffect = vi.fn();
    const query = vi
      .fn<RuntimeProfileQuery>()
      .mockRejectedValueOnce(new Error('Runtime profile handshake failed: native query timed out'))
      .mockResolvedValueOnce({
        profile: 'ordinary',
        appIdentifier: 'ai.jarvis.desktop',
        capabilityIdentifier: null,
        sessionNonceHash: null,
      });

    const mounted = render(
      <ErrorBoundary>
        <RuntimeProfileHandshakeGate
          plan={ordinaryPlan}
          expectation={undefined}
          query={query}
          nativeRuntime
        >
          <EffectChild effect={productEffect} />
        </RuntimeProfileHandshakeGate>
      </ErrorBoundary>,
    );
    await waitFor(() => expect(mounted.getByRole('alert')).toBeTruthy());
    expect(productEffect).not.toHaveBeenCalled();
    act(() => mounted.getByRole('button', { name: 'Try again' }).click());
    await waitFor(() => expect(mounted.getByTestId('product')).toBeTruthy());

    expect(query).toHaveBeenCalledTimes(2);
    expect(productEffect).toHaveBeenCalledOnce();
  });
});

describe('product-owned MonoChrome fixture readiness', () => {
  it('bypasses AuthGate only for the exact visual-test plan', () => {
    type RuntimeProfileAuthBoundaryComponent = React.ComponentType<{
      plan: typeof visualPlan;
      children: React.ReactNode;
    }>;
    const RuntimeProfileAuthBoundary = (
      AppModule as unknown as {
        RuntimeProfileAuthBoundary?: RuntimeProfileAuthBoundaryComponent;
      }
    ).RuntimeProfileAuthBoundary;

    expect(RuntimeProfileAuthBoundary).toBeTypeOf('function');
    if (!RuntimeProfileAuthBoundary) {
      throw new Error('RuntimeProfileAuthBoundary is unavailable');
    }
    const mounted = render(
      <RuntimeProfileAuthBoundary plan={visualPlan}>
        <output data-testid="visual-product" />
      </RuntimeProfileAuthBoundary>,
    );
    expect(mounted.getByTestId('visual-product')).toBeTruthy();
  });

  it('withholds exact native route-chat readiness until one authenticated commit succeeds', async () => {
    const commitResult = deferredValue<Awaited<ReturnType<MonochromeEvidenceCommit>>>();
    const commit = vi.fn<MonochromeEvidenceCommit>(() => commitResult.promise);
    const ControllerWithCommit = MonochromeFixtureController as React.ComponentType<
      React.ComponentProps<typeof MonochromeFixtureController> & {
        commit?: MonochromeEvidenceCommit;
      }
    >;
    const request: MonochromeFixtureRequest = {
      authorityId: 'route:chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'route:chat',
    };
    const query = vi.fn(async () => ({
      profile: MONOCHROME_VISUAL_TEST,
      appIdentifier: visualExpectation.appIdentifier,
      capabilityIdentifier: visualExpectation.capabilityIdentifier,
      sessionNonceHash: visualExpectation.sessionNonceHash,
      deniedEffects: {
        status: 'PASS' as const,
        manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
        counters: {
          notification: 0,
          processRelaunch: 0,
          updater: 0,
          shellOpen: 0,
          externalHttp: 0,
          keychain: 0,
          registry: 0,
          launcher: 0,
          tray: 0,
          singleInstance: 0,
          globalShortcut: 0,
          deepLink: 0,
          autostart: 0,
        },
      },
    }));
    const mounted = render(
      <React.StrictMode>
        <RuntimeProfileHandshakeGate
          plan={visualPlan}
          expectation={visualExpectation}
          query={query}
          nativeRuntime
        >
          <ControllerWithCommit plan={visualPlan} request={request} commit={commit}>
            <main data-monochrome-surface="chat" />
          </ControllerWithCommit>
        </RuntimeProfileHandshakeGate>
      </React.StrictMode>,
    );

    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(query).toHaveBeenCalledOnce();
    expect(mounted.queryByRole('status')).toBeNull();
    expect(mounted.container.querySelector('[data-monochrome-fixture-ready="true"]')).toBeNull();
    const commitRequest = commit.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(commitRequest)).toEqual([
      'nativeHandshake',
      'frontendHandshake',
      'readiness',
      'errors',
    ]);
    expect(commitRequest).not.toHaveProperty('deniedEffects');
    expect(commitRequest).toEqual({
      nativeHandshake: {
        profile: MONOCHROME_VISUAL_TEST,
        appIdentifier: visualExpectation.appIdentifier,
        capabilityIdentifier: visualExpectation.capabilityIdentifier,
        sessionNonceHash: visualExpectation.sessionNonceHash,
      },
      frontendHandshake: {
        profile: MONOCHROME_VISUAL_TEST,
        appIdentifier: visualExpectation.appIdentifier,
        capabilityIdentifier: visualExpectation.capabilityIdentifier,
        sessionNonceHash: visualExpectation.sessionNonceHash,
      },
      readiness: {
        status: 'PASS',
        application: 'READY',
        fixtureSmoke: 'PASS',
        surface: 'route:chat',
        theme: 'monochrome',
        font: 'READY',
        fallback: 'NOT_USED',
      },
      errors: { page: [], native: [] },
    });

    await act(async () =>
      commitResult.resolve({
        status: 'COMMITTED',
        schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
        sessionNonceHash: visualExpectation.sessionNonceHash,
        producer: {
          pid: 42,
          creationTimeUtc: '2026-07-30T12:34:56.789Z',
          creationTimeHash: '1'.repeat(64),
          executableHash: '2'.repeat(64),
          commandHash: '3'.repeat(64),
        },
      }),
    );
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
  });

  it('never calls the native evidence commit adapter for a browser fixture', async () => {
    const commit = vi.fn<MonochromeEvidenceCommit>();
    const request: MonochromeFixtureRequest = {
      authorityId: 'route:chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'route:chat',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request} commit={commit}>
        <main data-monochrome-surface="chat" />
      </MonochromeFixtureController>,
    );

    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    expect(commit).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.monochromeChatFixture).toBe('chat');
    expect(useUIStore.getState().activeChatId).toBe('fixture-chat-001');
    mounted.unmount();
    expect(document.documentElement.dataset.monochromeChatFixture).toBeUndefined();
  });

  it('never calls the native evidence commit adapter for a non-commit native fixture', async () => {
    const commit = vi.fn<MonochromeEvidenceCommit>(async () => {
      throw new Error('must not be called');
    });
    const request: MonochromeFixtureRequest = {
      authorityId: 'theme:monochrome',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'theme:monochrome',
    };
    const mounted = render(
      <RuntimeProfileHandshakeGate
        plan={visualPlan}
        expectation={visualExpectation}
        query={async () => ({
          profile: MONOCHROME_VISUAL_TEST,
          appIdentifier: visualExpectation.appIdentifier,
          capabilityIdentifier: visualExpectation.capabilityIdentifier,
          sessionNonceHash: visualExpectation.sessionNonceHash,
          deniedEffects: {
            status: 'PASS',
            manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
            counters: {
              notification: 0,
              processRelaunch: 0,
              updater: 0,
              shellOpen: 0,
              externalHttp: 0,
              keychain: 0,
              registry: 0,
              launcher: 0,
              tray: 0,
              singleInstance: 0,
              globalShortcut: 0,
              deepLink: 0,
              autostart: 0,
            },
          },
        })}
        nativeRuntime
      >
        <MonochromeFixtureController plan={visualPlan} request={request} commit={commit}>
          <main data-monochrome-surface="chat" />
        </MonochromeFixtureController>
      </RuntimeProfileHandshakeGate>,
    );

    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed without retry when the exact native evidence commit rejects', async () => {
    const commit = vi.fn<MonochromeEvidenceCommit>(async () => {
      throw new Error('private native detail');
    });
    const request: MonochromeFixtureRequest = {
      authorityId: 'route:chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'route:chat',
    };
    const mounted = render(
      <TestErrorBoundary>
        <RuntimeProfileHandshakeGate
          plan={visualPlan}
          expectation={visualExpectation}
          query={async () => ({
            profile: MONOCHROME_VISUAL_TEST,
            appIdentifier: visualExpectation.appIdentifier,
            capabilityIdentifier: visualExpectation.capabilityIdentifier,
            sessionNonceHash: visualExpectation.sessionNonceHash,
            deniedEffects: {
              status: 'PASS',
              manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
              counters: {
                notification: 0,
                processRelaunch: 0,
                updater: 0,
                shellOpen: 0,
                externalHttp: 0,
                keychain: 0,
                registry: 0,
                launcher: 0,
                tray: 0,
                singleInstance: 0,
                globalShortcut: 0,
                deepLink: 0,
                autostart: 0,
              },
            },
          })}
          nativeRuntime
        >
          <MonochromeFixtureController plan={visualPlan} request={request} commit={commit}>
            <main data-monochrome-surface="chat" />
          </MonochromeFixtureController>
        </RuntimeProfileHandshakeGate>
      </TestErrorBoundary>,
    );

    await waitFor(() => expect(mounted.getByTestId('failure')).toBeTruthy());
    expect(commit).toHaveBeenCalledOnce();
    expect(mounted.container.querySelector('[data-monochrome-fixture-ready="true"]')).toBeNull();
    await act(async () => undefined);
    expect(commit).toHaveBeenCalledOnce();
  });

  it.each([
    {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      requestedRoute: 'chat',
      requestedState: 'chat',
      requestedTheme: 'default',
      productTheme: 'default',
      origamiGate: false,
      selector: '[data-monochrome-surface="chat"]',
      surfaceId: 'baseline:default-chat',
    },
    {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      requestedRoute: 'chat',
      requestedState: 'chat',
      requestedTheme: 'jarvis',
      productTheme: 'jarvis',
      origamiGate: false,
      selector: '[data-monochrome-surface="chat"]',
      surfaceId: 'baseline:jarvis-chat',
    },
    {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      requestedRoute: 'chat',
      requestedState: 'chat',
      requestedTheme: 'origami',
      productTheme: 'vibespace',
      origamiGate: true,
      selector: '[data-monochrome-surface="chat"]',
      surfaceId: 'baseline:origami-chat',
    },
    {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      requestedRoute: 'chat',
      requestedState: 'chat',
      requestedTheme: 'vibespace',
      productTheme: 'vibespace',
      origamiGate: true,
      selector: '[data-monochrome-surface="chat"]',
      surfaceId: 'baseline:vibespace-chat',
    },
    {
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      fixtureId: 'settings-appearance',
      requestedRoute: 'terminal',
      requestedState: 'settings-appearance',
      requestedTheme: 'default',
      productTheme: 'default',
      origamiGate: false,
      selector: '#settings-panel-appearance',
      surfaceId: 'baseline:default-settings',
    },
    {
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      fixtureId: 'settings-appearance',
      requestedRoute: 'terminal',
      requestedState: 'settings-appearance',
      requestedTheme: 'jarvis',
      productTheme: 'jarvis',
      origamiGate: false,
      selector: '#settings-panel-appearance',
      surfaceId: 'baseline:jarvis-settings',
    },
    {
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      fixtureId: 'settings-appearance',
      requestedRoute: 'terminal',
      requestedState: 'settings-appearance',
      requestedTheme: 'vibespace',
      productTheme: 'vibespace',
      origamiGate: false,
      selector: '#settings-panel-appearance',
      surfaceId: 'baseline:vibespace-settings',
    },
    {
      fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
      fixtureId: 'terminal-workbench',
      requestedRoute: 'terminal',
      requestedState: 'terminal',
      requestedTheme: 'default',
      productTheme: 'default',
      origamiGate: false,
      selector: '[data-monochrome-route="terminal"]',
      surfaceId: 'baseline:default-terminal',
    },
    {
      fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
      fixtureId: 'terminal-workbench',
      requestedRoute: 'terminal',
      requestedState: 'terminal',
      requestedTheme: 'jarvis',
      productTheme: 'jarvis',
      origamiGate: false,
      selector: '[data-monochrome-route="terminal"]',
      surfaceId: 'baseline:jarvis-terminal',
    },
    {
      fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
      fixtureId: 'terminal-workbench',
      requestedRoute: 'terminal',
      requestedState: 'terminal',
      requestedTheme: 'vibespace',
      productTheme: 'vibespace',
      origamiGate: false,
      selector: '[data-monochrome-route="terminal"]',
      surfaceId: 'baseline:vibespace-terminal',
    },
  ] as const)(
    'binds exact baseline authority $surfaceId to its real product surface',
    ({
      fixtureHash,
      fixtureId,
      origamiGate,
      productTheme,
      requestedRoute,
      requestedState,
      requestedTheme,
      selector,
      surfaceId,
    }) => {
      type FixtureSurfaceResolver = (request: MonochromeFixtureRequest) => HTMLElement | null;
      const resolveMonochromeFixtureSurface = (
        AppModule as unknown as {
          resolveMonochromeFixtureSurface?: FixtureSurfaceResolver;
        }
      ).resolveMonochromeFixtureSurface;
      expect(resolveMonochromeFixtureSurface).toBeTypeOf('function');

      const mounted = render(
        fixtureId === 'chat' ? (
          <main data-monochrome-surface="chat" />
        ) : fixtureId === 'settings-appearance' ? (
          <section id="settings-panel-appearance" role="tabpanel" />
        ) : (
          <main data-monochrome-route="terminal" />
        ),
      );
      useUIStore.setState({
        route: requestedRoute,
        settingsOpen: fixtureId === 'settings-appearance',
      });
      const request: MonochromeFixtureRequest = {
        authorityId: surfaceId,
        fixtureHash,
        fixtureId,
        origamiGate,
        productTheme,
        requestedRoute,
        requestedState,
        requestedTheme,
        surfaceId,
      };

      expect(resolveMonochromeFixtureSurface!(request)).toBe(
        mounted.container.querySelector(selector),
      );
      mounted.unmount();
    },
  );

  it.each([
    ['a11y:pointer-targets', 'chat', '[data-monochrome-surface="chat"]'],
    ['a11y:forced-colors', 'chat', '[data-monochrome-surface="chat"]'],
    ['a11y:production-navigation', 'chat', '[data-monochrome-surface="chat"]'],
    ['theme:default', 'chat', '[data-monochrome-surface="chat"]'],
    ['theme:jarvis', 'chat', '[data-monochrome-surface="chat"]'],
    ['theme:monochrome', 'chat', '[data-monochrome-surface="chat"]'],
    ['theme:origami', 'chat', '[data-monochrome-surface="chat"]'],
    ['theme:vibespace', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:50%', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:80%', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:100%', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:125%', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:150%', 'chat', '[data-monochrome-surface="chat"]'],
    ['zoom:200%', 'chat', '[data-monochrome-surface="chat"]'],
    ['spatial:canvas', 'canvas', '[data-monochrome-route="canvas"]'],
    ['spatial:context', 'context', '[data-monochrome-route="context"]'],
  ] as const)(
    'binds exact stateless authority %s to its real product root',
    (surfaceId, requestedRoute, selector) => {
      const resolveMonochromeFixtureSurface = AppModule.resolveMonochromeFixtureSurface;
      const mounted = render(
        requestedRoute === 'chat' ? (
          <main data-monochrome-surface="chat" />
        ) : (
          <main data-monochrome-route={requestedRoute} />
        ),
      );
      useUIStore.setState({ route: requestedRoute });
      const request: MonochromeFixtureRequest = {
        fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
        fixtureId: 'chat',
        origamiGate: surfaceId === 'theme:origami',
        productTheme: surfaceId === 'theme:origami' ? 'vibespace' : 'monochrome',
        requestedRoute,
        requestedState: surfaceId.includes('contrast') ? 'tooltip-visible' : undefined,
        requestedTheme: surfaceId === 'theme:origami' ? 'origami' : 'monochrome',
        surfaceId,
      };

      expect(resolveMonochromeFixtureSurface(request)).toBe(
        mounted.container.querySelector(selector),
      );
      mounted.unmount();
    },
  );

  it.each([
    {
      surfaceId: 'state:usage',
      requestedRoute: 'account',
      requestedState: 'usage',
      selector: '.mc7f-account-page [role="tabpanel"][data-state="active"]',
      child: (
        <main className="mc7f-account-page">
          <button role="tab" data-state="active" aria-controls="account-usage-panel">
            Usage
          </button>
          <section id="account-usage-panel" role="tabpanel" data-state="active" />
        </main>
      ),
    },
    {
      surfaceId: 'state:billing-plans',
      requestedRoute: 'chat',
      requestedState: 'billing',
      settingsTab: 'plans',
      selector: '#settings-panel-plans',
      child: <section id="settings-panel-plans" role="tabpanel" />,
    },
    {
      surfaceId: 'state:dropdown-open',
      requestedRoute: 'chat',
      requestedState: 'dropdown-open',
      selector: '.jarvis-slash-dropdown',
      child: <section className="jarvis-slash-dropdown" />,
    },
    {
      surfaceId: 'state:tooltip-visible',
      requestedRoute: 'chat',
      requestedState: 'tooltip-visible',
      selector: '#navigation-tooltip',
      child: (
        <>
          <button aria-label="Toggle navigation" aria-describedby="navigation-tooltip" />
          <aside id="navigation-tooltip" role="tooltip">
            Show sidebar
          </aside>
        </>
      ),
    },
    {
      surfaceId: 'a11y:text-contrast',
      requestedRoute: 'chat',
      requestedState: 'tooltip-visible',
      selector: '#navigation-tooltip',
      child: (
        <>
          <button aria-label="Toggle navigation" aria-describedby="navigation-tooltip" />
          <aside id="navigation-tooltip" role="tooltip">
            Show sidebar
          </aside>
        </>
      ),
    },
    {
      surfaceId: 'a11y:non-text-contrast',
      requestedRoute: 'chat',
      requestedState: 'tooltip-visible',
      selector: '#navigation-tooltip',
      child: (
        <>
          <button aria-label="Toggle navigation" aria-describedby="navigation-tooltip" />
          <aside id="navigation-tooltip" role="tooltip">
            Show sidebar
          </aside>
        </>
      ),
    },
    {
      surfaceId: 'state:empty-state',
      requestedRoute: 'chat',
      requestedState: 'empty',
      selector: '[data-vibespace-empty-chat]',
      child: <section data-vibespace-empty-chat />,
    },
    {
      surfaceId: 'state:modal-open',
      requestedRoute: 'chat',
      requestedState: 'modal-open',
      selector: '.mc7f-settings-modal[role="dialog"]',
      child: <section className="mc7f-settings-modal" role="dialog" />,
    },
    {
      surfaceId: 'state:toast-visible',
      requestedRoute: 'chat',
      requestedState: 'toast-visible',
      selector: '.pointer-events-auto',
      child: (
        <article className="pointer-events-auto">
          <button aria-label="Dismiss" />
        </article>
      ),
    },
    {
      surfaceId: 'state:locked-access',
      requestedRoute: 'account',
      requestedState: 'locked',
      selector: '.mc7f-access-paywall',
      child: <section className="mc7f-access-paywall" />,
    },
  ] as const)(
    'binds exact legacy state authority $surfaceId to its real product surface',
    ({ child, requestedRoute, requestedState, selector, settingsTab, surfaceId }) => {
      const mounted = render(child);
      useUIStore.setState({
        route: requestedRoute,
        settingsOpen: settingsTab !== undefined,
      });
      const request: MonochromeFixtureRequest = {
        fixtureHash:
          settingsTab || surfaceId === 'state:locked-access'
            ? '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875'
            : 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
        fixtureId:
          settingsTab || surfaceId === 'state:locked-access' ? 'settings-appearance' : 'chat',
        origamiGate: false,
        productTheme: 'monochrome',
        requestedRoute,
        requestedState,
        requestedTheme: 'monochrome',
        settingsTab,
        surfaceId,
      };

      expect(AppModule.resolveMonochromeFixtureSurface(request)).toBe(
        mounted.container.querySelector(selector),
      );
      mounted.unmount();
    },
  );

  it.each([
    {
      surfaceId: 'state:dropdown-open',
      requestedRoute: 'chat',
      requestedState: 'dropdown-open',
      selector: 'button[aria-label="Choose model"]',
      child: <button aria-label="Choose model" />,
      event: 'click',
    },
    {
      surfaceId: 'state:tooltip-visible',
      requestedRoute: 'chat',
      requestedState: 'tooltip-visible',
      selector: 'button[aria-label="Toggle navigation"]',
      child: <button aria-label="Toggle navigation" />,
      event: 'focus',
    },
  ] as const)(
    'activates $surfaceId through its real product control',
    ({ child, event, requestedRoute, requestedState, selector, surfaceId }) => {
      type ProductStateActivator = (request: MonochromeFixtureRequest) => void;
      const activate = (
        AppModule as unknown as {
          activateMonochromeFixtureProductState?: ProductStateActivator;
        }
      ).activateMonochromeFixtureProductState;
      expect(activate).toBeTypeOf('function');
      const mounted = render(child);
      const control = mounted.container.querySelector<HTMLElement>(selector);
      const observed = vi.fn();
      control?.addEventListener(event, observed);
      activate!({
        fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
        fixtureId: 'chat',
        origamiGate: false,
        productTheme: 'monochrome',
        requestedRoute,
        requestedState,
        requestedTheme: 'monochrome',
        surfaceId,
      });
      expect(observed).toHaveBeenCalledOnce();
      mounted.unmount();
    },
  );

  it('does not substitute a synthetic click for Usage deep-link activation', () => {
    const mounted = render(
      <main className="mc7f-account-page">
        <button role="tab" data-state="active" aria-controls="account-profile-panel">
          Profile
        </button>
        <button role="tab" data-state="inactive" aria-controls="account-usage-panel">
          Usage
        </button>
        <section id="account-profile-panel" role="tabpanel" data-state="active" />
        <section id="account-usage-panel" role="tabpanel" data-state="inactive" />
      </main>,
    );
    useUIStore.setState({ route: 'account' });
    const request: MonochromeFixtureRequest = {
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      fixtureId: 'settings-appearance',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'account',
      requestedState: 'usage',
      requestedTheme: 'monochrome',
      surfaceId: 'state:usage',
    };
    const usageTab = mounted.getByRole('tab', { name: 'Usage' });
    const observedClick = vi.fn();
    usageTab.addEventListener('click', observedClick);

    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBeNull();
    expect(AppModule.activateMonochromeFixtureProductState(request)).toBe(false);
    expect(observedClick).not.toHaveBeenCalled();
    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBeNull();
    mounted.unmount();
  });

  it('accepts Usage only after the deep link activates its exact controlled panel', () => {
    const mounted = render(
      <main className="mc7f-account-page">
        <button role="tab" data-state="inactive" aria-controls="account-profile-panel">
          Profile
        </button>
        <button role="tab" data-state="active" aria-controls="account-usage-panel">
          Usage
        </button>
        <section id="account-profile-panel" role="tabpanel" data-state="inactive" />
        <section id="account-usage-panel" role="tabpanel" data-state="active" />
      </main>,
    );
    useUIStore.setState({ route: 'account' });
    const request: MonochromeFixtureRequest = {
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      fixtureId: 'settings-appearance',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'account',
      requestedState: 'usage',
      requestedTheme: 'monochrome',
      surfaceId: 'state:usage',
    };
    const observedClick = vi.fn();
    mounted.getByRole('tab', { name: 'Usage' }).addEventListener('click', observedClick);

    expect(AppModule.activateMonochromeFixtureProductState(request)).toBe(true);
    expect(observedClick).not.toHaveBeenCalled();
    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBe(
      mounted.container.querySelector('#account-usage-panel'),
    );
    mounted.unmount();
  });

  it('binds tooltip readiness to the focused navigation trigger, not an unrelated tooltip', () => {
    const mounted = render(
      <>
        <aside id="unrelated-tooltip" role="tooltip">
          Unrelated product tooltip
        </aside>
        <button aria-label="Toggle navigation" />
        <aside id="navigation-tooltip" role="tooltip">
          Show sidebar
        </aside>
      </>,
    );
    useUIStore.setState({ route: 'chat' });
    const request: MonochromeFixtureRequest = {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedState: 'tooltip-visible',
      requestedTheme: 'monochrome',
      surfaceId: 'state:tooltip-visible',
    };
    const trigger = mounted.getByRole('button', { name: 'Toggle navigation' });
    const navigationTooltip = mounted.container.querySelector<HTMLElement>('#navigation-tooltip');
    trigger.addEventListener('focus', () => {
      trigger.setAttribute('aria-describedby', 'navigation-tooltip');
    });

    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBeNull();
    expect(AppModule.activateMonochromeFixtureProductState(request)).toBe(true);
    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBe(navigationTooltip);
    mounted.unmount();
  });

  it('sets and cleans the exact real-empty-chat controller marker', async () => {
    const request: MonochromeFixtureRequest = {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedState: 'empty',
      requestedTheme: 'monochrome',
      surfaceId: 'state:empty-state',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <section data-vibespace-empty-chat />
      </MonochromeFixtureController>,
    );
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    expect(document.documentElement.dataset.monochromeChatState).toBe('empty-state');
    mounted.unmount();
    expect(document.documentElement.dataset.monochromeChatState).toBeUndefined();
  });

  it('fails closed instead of guessing a product surface from an unknown ID suffix', () => {
    const mounted = render(<main data-monochrome-surface="chat" />);
    useUIStore.setState({ route: 'chat' });
    const request: MonochromeFixtureRequest = {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'unknown:chat',
    };

    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBeNull();
    mounted.unmount();
  });

  it.each([
    ['account', '.mc7f-account-page'],
    ['agent-detail', '[data-monochrome-route="agent-detail"]'],
    ['agents', '[data-monochrome-route="agents"]'],
    ['benchmarks', '[data-monochrome-route="benchmarks"]'],
    ['browser', '.browser-shell'],
    ['canvas', '[data-monochrome-route="canvas"]'],
    ['chat', '[data-monochrome-surface="chat"]'],
    ['context', '[data-monochrome-route="context"]'],
    ['files', '[data-monochrome-route="files"]'],
    ['history', '[data-monochrome-route="history"]'],
    ['kanban', '[data-monochrome-route="kanban"]'],
    ['preview', '[data-monochrome-route="preview"]'],
    ['project-detail', '[data-monochrome-route="project-detail"]'],
    ['schedule', '[data-monochrome-route="schedule"]'],
    ['skills', '[data-monochrome-route="skills"]'],
    ['terminal', '[data-monochrome-route="terminal"]'],
    ['tools', '[data-monochrome-route="tools"]'],
    ['workbench', '[data-monochrome-route="workbench"]'],
  ] as const)('binds a11y:route:%s to that route’s visible product root', (route, selector) => {
    const mounted = render(
      route === 'chat' ? (
        <main data-monochrome-surface="chat" />
      ) : route === 'account' ? (
        <main className="mc7f-account-page" />
      ) : route === 'browser' ? (
        <main className="browser-shell" />
      ) : (
        <main data-monochrome-route={route} />
      ),
    );
    useUIStore.setState({ route });
    const request: MonochromeFixtureRequest = {
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: route,
      requestedTheme: 'monochrome',
      surfaceId: `a11y:route:${route}`,
    };

    expect(AppModule.resolveMonochromeFixtureSurface(request)).toBe(
      mounted.container.querySelector(selector),
    );
    mounted.unmount();
  });

  it('applies route/theme through the real store and emits evidence only after the surface exists', async () => {
    const request = {
      fixtureId: 'chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      surfaceId: 'route:chat',
      requestedTheme: 'monochrome' as const,
      productTheme: 'monochrome' as const,
      origamiGate: false,
      requestedRoute: 'chat',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <main data-monochrome-surface="chat" />
      </MonochromeFixtureController>,
    );
    expect(mounted.queryByRole('status')).toBeNull();
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    const marker = mounted.container.querySelector(
      '[data-monochrome-fixture-ready="true"]',
    ) as HTMLElement;
    expect(useUIStore.getState()).toMatchObject({ route: 'chat', theme: 'monochrome' });
    expect(document.documentElement.dataset.theme).toBe('monochrome');
    expect(marker.dataset).toMatchObject({
      runtimeProfile: MONOCHROME_VISUAL_TEST,
      fixtureHash: request.fixtureHash,
      resolvedTheme: 'monochrome',
      documentTheme: 'monochrome',
      fontReady: 'true',
      fallback: 'false',
      origamiGate: 'false',
    });
    expect(marker.getAttribute('data-surface-id')).toBeNull();
    expect(marker.getAttribute('data-monochrome-surface-id')).toBeNull();
    expect(
      mounted.container
        .querySelector('[data-monochrome-surface="chat"]')
        ?.getAttribute('data-monochrome-surface-id'),
    ).toBe('route:chat');
  });

  it('continues readiness polling when a hidden native window suspends animation frames', async () => {
    const request = {
      fixtureId: 'chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      surfaceId: 'route:chat',
      requestedTheme: 'monochrome' as const,
      productTheme: 'monochrome' as const,
      origamiGate: false,
      requestedRoute: 'chat',
    };
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <div />
      </MonochromeFixtureController>,
    );

    try {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      mounted.rerender(
        <MonochromeFixtureController plan={visualPlan} request={request}>
          <main data-monochrome-surface="chat" />
        </MonochromeFixtureController>,
      );

      await waitFor(
        () =>
          expect(
            mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
          ).not.toBeNull(),
        { timeout: 250 },
      );
      expect(animationFrame).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      animationFrame.mockRestore();
    }
  });

  it('keeps Origami as requested evidence while validating the real vibespace document theme', async () => {
    const request = {
      fixtureId: 'chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      surfaceId: 'theme:origami',
      requestedTheme: 'origami' as const,
      productTheme: 'vibespace' as const,
      origamiGate: true,
      requestedRoute: 'chat',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <main data-monochrome-surface="chat" />
      </MonochromeFixtureController>,
    );
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    const marker = mounted.container.querySelector(
      '[data-monochrome-fixture-ready="true"]',
    ) as HTMLElement;
    expect(marker.dataset).toMatchObject({
      resolvedTheme: 'origami',
      documentTheme: 'vibespace',
      origamiGate: 'true',
    });
    expect(document.documentElement.dataset.theme).toBe('vibespace');
  });

  it.each(['default', 'vibespace', 'jarvis'] as const)(
    'replays the %s Appearance overlay above the terminal route',
    async (theme) => {
      const request = {
        fixtureId: 'settings-appearance',
        fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
        surfaceId: `state:modal-open-${theme}`,
        requestedTheme: theme,
        productTheme: theme,
        origamiGate: false,
        requestedRoute: 'terminal',
        requestedState: 'settings-appearance',
      };
      const mounted = render(
        <MonochromeFixtureController plan={visualPlan} request={request}>
          <section id="settings-panel-appearance" role="tabpanel" />
        </MonochromeFixtureController>,
      );
      await waitFor(() =>
        expect(
          mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
        ).not.toBeNull(),
      );
      expect(useUIStore.getState()).toMatchObject({
        route: 'terminal',
        settingsOpen: true,
        theme,
      });
      expect(
        mounted.container
          .querySelector('#settings-panel-appearance')
          ?.getAttribute('data-monochrome-surface-id'),
      ).toBe(request.surfaceId);
      mounted.unmount();
    },
  );

  it.each([
    ['overlay:actions-palette-host', 'actions-palette'],
    ['overlay:command-palette-host', 'command-palette'],
  ] as const)(
    'binds %s evidence only to its distinct real overlay node',
    async (authorityId, hook) => {
      const request = {
        fixtureId: 'chat',
        fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
        surfaceId: authorityId,
        requestedTheme: 'monochrome' as const,
        productTheme: 'monochrome' as const,
        origamiGate: false,
        requestedRoute: 'chat',
        requestedState: authorityId,
        authorityId,
      };
      const mounted = render(
        <MonochromeFixtureController plan={visualPlan} request={request}>
          <main data-monochrome-surface="chat" />
          <section data-monochrome-surface={hook} />
        </MonochromeFixtureController>,
      );
      await waitFor(() =>
        expect(
          mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
        ).not.toBeNull(),
      );
      expect(
        mounted.container
          .querySelector(`[data-monochrome-surface="${hook}"]`)
          ?.getAttribute('data-monochrome-surface-id'),
      ).toBe(request.surfaceId);
      expect(
        mounted.container
          .querySelector('[data-monochrome-surface="chat"]')
          ?.hasAttribute('data-monochrome-surface-id'),
      ).toBe(false);
    },
  );

  it.each([
    'about',
    'accessibility',
    'account',
    'admin',
    'allaboutme',
    'ambient',
    'appearance',
    'composerstt',
    'connections',
    'hive',
    'hotkeys',
    'jarvisactions',
    'localmodels',
    'notifications',
    'phone',
    'plans',
    'plugins',
    'providers',
    'voice',
  ] as const)('binds settings:%s to only its exact visible tab panel', async (tab) => {
    const request = {
      fixtureId: 'settings-appearance',
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      surfaceId: `settings:${tab}`,
      requestedTheme: 'monochrome' as const,
      productTheme: 'monochrome' as const,
      origamiGate: false,
      requestedRoute: 'chat',
      authorityId: `settings:${tab}`,
      settingsTab: tab,
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <section id={`settings-panel-${tab}`} role="tabpanel" />
      </MonochromeFixtureController>,
    );
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    expect(
      mounted.container
        .querySelector(`#settings-panel-${tab}`)
        ?.getAttribute('data-monochrome-surface-id'),
    ).toBe(`settings:${tab}`);
    mounted.unmount();
  });

  it('keeps visual settings replay entirely inside fixture memory', async () => {
    const getLastSettingsTab = vi.spyOn(settingsTabMemory, 'getLastSettingsTab');
    const rememberSettingsTab = vi.spyOn(settingsTabMemory, 'rememberSettingsTab');
    const request = {
      fixtureId: 'settings-appearance',
      fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
      surfaceId: 'settings:providers',
      requestedTheme: 'monochrome' as const,
      productTheme: 'monochrome' as const,
      origamiGate: false,
      requestedRoute: 'chat',
      authorityId: 'settings:providers',
      settingsTab: 'providers',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <section id="settings-panel-providers" role="tabpanel" />
      </MonochromeFixtureController>,
    );
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
      ).not.toBeNull(),
    );
    expect(resolveSettingsModalInitialTab(visualPlan)).toBe('providers');
    expect(getLastSettingsTab).not.toHaveBeenCalled();
    expect(rememberSettingsTab).not.toHaveBeenCalled();
    mounted.unmount();
    getLastSettingsTab.mockRestore();
    rememberSettingsTab.mockRestore();
  });

  it('preserves ordinary settings-tab memory behavior', () => {
    const getLastSettingsTab = vi
      .spyOn(settingsTabMemory, 'getLastSettingsTab')
      .mockReturnValue('voice');
    expect(resolveSettingsModalInitialTab(ordinaryPlan)).toBe('voice');
    expect(getLastSettingsTab).toHaveBeenCalledOnce();
    getLastSettingsTab.mockRestore();
  });

  it('shows the real Admin panel only for an explicit visual preview when the account is not admin', async () => {
    const previousAuth = useAuthStore.getState();
    useAuthStore.setState({
      email: undefined,
      localUserId: null,
      cloudSession: null,
    });
    useUIStore.setState({ settingsOpen: true });

    const preview = render(<SettingsModal initialTab="admin" visualAdminPreview />);
    await waitFor(() => {
      expect(document.querySelector('#settings-tab-admin')).not.toBeNull();
      expect(document.querySelector('#settings-panel-admin')).not.toBeNull();
    });
    expect(document.querySelector('#settings-tab-admin')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect((document.querySelector('#settings-panel-admin') as HTMLElement).hidden).toBe(false);
    preview.unmount();

    const ordinary = render(<SettingsModal initialTab="admin" />);
    await waitFor(() => {
      expect(document.querySelector('#settings-tab-admin')).toBeNull();
      expect((document.querySelector('#settings-panel-admin') as HTMLElement).hidden).toBe(true);
      expect(document.querySelector('#settings-tab-plans')?.getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    ordinary.unmount();
    useAuthStore.setState(previousAuth);
  });

  it.each([
    {
      authorityId: 'access:app-host',
      requestedRoute: 'account',
      selector: '.mc7f-access-app-host',
    },
    {
      authorityId: 'access:banner',
      requestedRoute: 'account',
      selector: '.mc7f-access-banner',
    },
    {
      authorityId: 'access:locked',
      requestedRoute: 'account',
      selector: '.mc7f-access-paywall',
    },
    {
      authorityId: 'development:monochrome-workbench',
      requestedRoute: 'chat',
      selector: '[data-monochrome-development-surface="true"]',
      child: <main data-monochrome-development-surface="true" />,
    },
    {
      authorityId: 'embedded:browser-operator',
      requestedRoute: 'browser',
      selector: '.browser-shell',
      child: <main className="browser-shell" />,
    },
    {
      authorityId: 'embedded:command-center',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="jarvis-command-center"]',
    },
    {
      authorityId: 'embedded:prompt-forge',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="prompt-forge"]',
    },
    {
      authorityId: 'overlay:celebration-host',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="celebration-host"]',
    },
    {
      authorityId: 'overlay:call-modal',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="call"]',
    },
    {
      authorityId: 'overlay:file-explorer-host',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="file-explorer-dialog"]',
    },
    {
      authorityId: 'overlay:jarvis-context-menu',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="context-menu"]',
    },
    {
      authorityId: 'overlay:news-host',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="news-host"]',
    },
    {
      authorityId: 'overlay:page-router',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="page-router"]',
    },
    {
      authorityId: 'overlay:update-warning-host',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="update-warning-host"]',
    },
    {
      authorityId: 'overlay:wellness-break',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="wellness-break"]',
    },
    {
      authorityId: 'overlay:whats-new-host',
      requestedRoute: 'chat',
      selector: '[data-monochrome-surface="whats-new-modal"]',
    },
    {
      authorityId: 'overlay:activity-strip',
      requestedRoute: 'chat',
      selector: '[role="status"][aria-label="Active agents"]',
      child: <aside role="status" aria-label="Active agents" />,
    },
    {
      authorityId: 'overlay:api-key-save-burst',
      requestedRoute: 'chat',
      selector: '.mc7f-api-key-save-burst',
    },
    {
      authorityId: 'overlay:app-dispatch',
      requestedRoute: 'chat',
      selector: 'main[aria-label="Workspace"]',
      child: <main aria-label="Workspace" />,
    },
    {
      authorityId: 'overlay:toaster',
      requestedRoute: 'chat',
      selector: 'button[aria-label="Dismiss"]',
      child: <Toaster />,
    },
  ] as const)(
    'resolves $authorityId only through its real visible product surface',
    async ({ authorityId, requestedRoute, selector, child }) => {
      const isAccessFixture = authorityId.startsWith('access:');
      const isTerminalFixture = authorityId === 'development:monochrome-workbench';
      const request = {
        fixtureId: isAccessFixture
          ? 'settings-appearance'
          : isTerminalFixture
            ? 'terminal-workbench'
            : 'chat',
        fixtureHash: isAccessFixture
          ? '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875'
          : isTerminalFixture
            ? 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b'
            : 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
        surfaceId: authorityId,
        requestedTheme: 'monochrome' as const,
        productTheme: 'monochrome' as const,
        origamiGate: false,
        requestedRoute,
        ...(authorityId === 'access:locked'
          ? { requestedState: 'locked' }
          : authorityId === 'embedded:browser-operator'
            ? { requestedState: 'operator' }
            : authorityId === 'embedded:command-center'
              ? { requestedState: 'command-center' }
              : authorityId === 'embedded:prompt-forge'
                ? { requestedState: 'prompt-forge' }
                : isAccessFixture || isTerminalFixture
                  ? {}
                  : { requestedState: authorityId }),
        authorityId,
      };
      const mounted = render(
        <MonochromeFixtureController plan={visualPlan} request={request}>
          {child ?? <main data-monochrome-surface="chat" />}
        </MonochromeFixtureController>,
      );
      const evidenceScope =
        authorityId === 'overlay:call-modal' ||
        authorityId === 'overlay:file-explorer-host' ||
        authorityId === 'overlay:update-warning-host' ||
        authorityId === 'overlay:whats-new-host'
          ? document
          : mounted.container;
      await waitFor(() => expect(evidenceScope.querySelector(selector)).not.toBeNull(), {
        timeout: 4_000,
      });
      await waitFor(
        () =>
          expect(
            mounted.container.querySelector('[data-monochrome-fixture-ready="true"]'),
          ).not.toBeNull(),
        { timeout: 4_000 },
      );
      const visibleProductNode = evidenceScope.querySelector(selector);
      expect(visibleProductNode).not.toBeNull();
      const evidencedNode =
        authorityId === 'overlay:toaster'
          ? visibleProductNode?.closest('.pointer-events-auto')
          : visibleProductNode;
      expect(evidencedNode?.getAttribute('data-monochrome-surface-id')).toBe(authorityId);
      expect(evidenceScope.querySelectorAll('[data-monochrome-surface-id]')).toHaveLength(1);
      if (authorityId === 'overlay:activity-strip') {
        expect(useUIStore.getState().chatMode).toBe('council');
      }
      mounted.unmount();
    },
    10_000,
  );

  it('does not let an absent overlay self-attest through the underlying chat route', async () => {
    const request = {
      fixtureId: 'chat',
      fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
      surfaceId: 'state:actions-palette',
      requestedTheme: 'monochrome' as const,
      productTheme: 'monochrome' as const,
      origamiGate: false,
      requestedRoute: 'chat',
      requestedState: 'actions-palette',
    };
    const mounted = render(
      <MonochromeFixtureController plan={visualPlan} request={request}>
        <main data-monochrome-surface="chat" />
      </MonochromeFixtureController>,
    );
    await act(async () => undefined);
    expect(mounted.container.querySelector('[data-monochrome-fixture-ready="true"]')).toBeNull();
    expect(
      mounted.container
        .querySelector('[data-monochrome-surface="chat"]')
        ?.hasAttribute('data-monochrome-surface-id'),
    ).toBe(false);
    mounted.unmount();
  });
});

describe('behavioral local adapter admission', () => {
  type HydrationRunner = (
    plan: typeof visualPlan,
    adapters: {
      openDatabase(): Promise<void>;
      listAgents(): Promise<readonly never[]>;
      registerAgents(agents: readonly never[]): void;
    },
  ) => Promise<void>;

  const runner = (AppModule as unknown as { runRuntimeAdmittedLocalHydration?: HydrationRunner })
    .runRuntimeAdmittedLocalHydration;

  it('admits zero persistence or repository adapters in visual mode', async () => {
    expect(runner).toBeTypeOf('function');
    const adapters = {
      openDatabase: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
      registerAgents: vi.fn(),
    };
    await runner!(visualPlan, adapters);
    expect(adapters.openDatabase).not.toHaveBeenCalled();
    expect(adapters.listAgents).not.toHaveBeenCalled();
    expect(adapters.registerAgents).toHaveBeenCalledOnce();
  });

  it('keeps ordinary persistence and repository adapters reachable', async () => {
    expect(runner).toBeTypeOf('function');
    const agents: readonly never[] = [];
    const adapters = {
      openDatabase: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => agents),
      registerAgents: vi.fn(),
    };
    await runner!(ordinaryPlan, adapters);
    expect(adapters.openDatabase).toHaveBeenCalledOnce();
    expect(adapters.listAgents).toHaveBeenCalledOnce();
    expect(adapters.registerAgents).toHaveBeenCalledWith(agents);
  });
});

function EffectChild({ effect }: { effect: () => void }) {
  React.useEffect(effect, [effect]);
  return <output data-testid="product" />;
}

describe('runtime-plan call-site inventory (secondary static oracle)', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  const runtimeSource = readFileSync(resolve(process.cwd(), 'src/lib/runtimeProfile.ts'), 'utf8');
  const updatesSource = readFileSync(resolve(process.cwd(), 'src/lib/updates.ts'), 'utf8');

  it('maps every declared enabled flag to at least one guarded production call site', () => {
    const flags = [...runtimeSource.matchAll(/readonly (\w+Enabled): boolean/g)].map(
      (match) => match[1],
    );
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(
        `${appSource}\n${updatesSource}`,
        `${flag} must guard a production mount/call site`,
      ).toContain(`plan.${flag}`);
    }
  });

  it('guards formerly unguarded lifecycle and kernel-smoke mounts', () => {
    expect(appSource).toContain('{plan.lifecycleEnabled ? <VoiceModuleLifecycle /> : null}');
    expect(appSource).toContain('plan.kernelEnabled && KERNEL_SMOKE_ENABLED');
    expect(appSource).toContain('{plan.idleEnabled ? <IdleDetectionHost /> : null}');
  });
});
