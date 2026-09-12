import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeRecoveryCallback,
  resetRecoveryCallbackConsumptionForTests,
} from './recoveryCallback';

function browserAt(href: string) {
  let currentHref = href;
  return {
    location: {
      get href() {
        return currentHref;
      },
    },
    history: {
      replaceState: vi.fn((_state, _title, next: string) => {
        currentHref = new URL(next, currentHref).href;
      }),
    },
  };
}

describe('recovery callback consumption', () => {
  beforeEach(() => resetRecoveryCallbackConsumptionForTests());

  it('clears fragment secrets before establishing a bounded recovery session', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=access-secret&refresh_token=refresh-secret&type=recovery&expires_in=3600',
    );
    const setSession = vi.fn(async () => ({
      data: {
        session: {
          access_token: 'access-secret',
          user: { id: 'user-a', email: 'owner@example.test' },
        },
      },
      error: null,
    }));

    const pending = consumeRecoveryCallback(browser, {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      setSession,
      exchangeCodeForSession: vi.fn(),
    });

    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
    expect(setSession).not.toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({
      status: 'ready',
      userId: 'user-a',
      email: 'owner@example.test',
    });
    expect(setSession).toHaveBeenCalledWith({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
    });
  });

  it('returns a one-shot opaque capability bound to the exact established session', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=access-secret&refresh_token=refresh-secret&type=recovery',
    );

    const result = await consumeRecoveryCallback(browser, {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      setSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: 'access-secret',
            user: { id: 'user-a', email: 'Owner@Example.test' },
          },
        },
        error: null,
      })),
      exchangeCodeForSession: vi.fn(),
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready recovery callback');
    expect(Object.keys(result)).not.toContain('accessToken');
    expect(JSON.stringify(result)).not.toContain('access-secret');
    expect(result.ownership.matchesSession).toBeTypeOf('function');
    expect(
      result.ownership.matchesSession({
        session: {
          access_token: 'access-secret',
          user: { id: 'user-a', email: 'owner@example.test' },
        },
      }),
    ).toBe(true);
    expect(
      result.ownership.matchesSession({
        session: {
          access_token: 'newer-token',
          user: { id: 'user-a', email: 'owner@example.test' },
        },
      }),
    ).toBe(false);
    result.ownership.release();
    expect(
      result.ownership.matchesSession({
        session: {
          access_token: 'access-secret',
          user: { id: 'user-a', email: 'owner@example.test' },
        },
      }),
    ).toBe(false);
    expect(() => result.ownership.release()).not.toThrow();
  });

  it('rejects and scrubs a non-recovery auth fragment without establishing a session', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=secret&refresh_token=secret&type=signup',
    );
    const setSession = vi.fn();

    await expect(
      consumeRecoveryCallback(browser, {
        getSession: vi.fn(),
        setSession,
        exchangeCodeForSession: vi.fn(),
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'This recovery link is invalid or has expired. Request a new one.',
    });
    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
    expect(setSession).not.toHaveBeenCalled();
  });

  it('clears a bounded recovery code before exchanging it', async () => {
    const browser = browserAt('http://127.0.0.1:5173/account?code=recovery-code&type=recovery');
    const exchangeCodeForSession = vi.fn(async () => ({
      data: {
        session: {
          access_token: 'code-session-token',
          user: { id: 'user-a', email: 'owner@example.test' },
        },
      },
      error: null,
    }));

    const pending = consumeRecoveryCallback(browser, {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      setSession: vi.fn(),
      exchangeCodeForSession,
    });

    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({
      status: 'ready',
      userId: 'user-a',
    });
    expect(exchangeCodeForSession).toHaveBeenCalledWith('recovery-code');
  });

  it('scrubs provider errors and returns only a generic recovery error', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account?type=recovery&error=access_denied&error_description=sensitive-detail',
    );

    await expect(
      consumeRecoveryCallback(browser, {
        getSession: vi.fn(),
        setSession: vi.fn(),
        exchangeCodeForSession: vi.fn(),
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'This recovery link is invalid or has expired. Request a new one.',
    });
    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
  });

  it('still scrubs callback secrets when cloud Auth is unavailable', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=secret&refresh_token=secret&type=recovery',
    );

    await expect(consumeRecoveryCallback(browser, null)).resolves.toMatchObject({
      status: 'error',
    });
    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
  });

  it('fails closed without Auth access or logging when callback URL scrubbing throws', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=access-secret&refresh_token=refresh-secret&type=recovery',
    );
    browser.history.replaceState = vi.fn(() => {
      throw new Error('history replacement failed');
    });
    const getSession = vi.fn();
    const setSession = vi.fn();
    const exchangeCodeForSession = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession,
        exchangeCodeForSession,
      }),
    ).resolves.toEqual({
      status: 'error',
      message: 'This recovery link is invalid or has expired. Request a new one.',
    });

    expect(getSession).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  it.each([
    ['duplicate type', 'http://127.0.0.1:5173/account?type=recovery&type=recovery&code=code-a'],
    ['duplicate code', 'http://127.0.0.1:5173/account?type=recovery&code=code-a&code=code-b'],
    [
      'duplicate access token',
      'http://127.0.0.1:5173/account#type=recovery&access_token=one&access_token=two&refresh_token=refresh',
    ],
    [
      'duplicate refresh token',
      'http://127.0.0.1:5173/account#type=recovery&access_token=access&refresh_token=one&refresh_token=two',
    ],
    [
      'cross-source type conflict',
      'http://127.0.0.1:5173/account?type=recovery&code=code-a#type=recovery',
    ],
    [
      'cross-source transport conflict',
      'http://127.0.0.1:5173/account?type=recovery&code=code-a#access_token=access&refresh_token=refresh',
    ],
    ['empty code', 'http://127.0.0.1:5173/account?type=recovery&code='],
    [
      'empty token',
      'http://127.0.0.1:5173/account#type=recovery&access_token=&refresh_token=refresh',
    ],
  ])('rejects and scrubs %s callback parameters', async (_label, href) => {
    const browser = browserAt(href);
    const setSession = vi.fn();
    const exchangeCodeForSession = vi.fn();

    await expect(
      consumeRecoveryCallback(browser, {
        getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
        setSession,
        exchangeCodeForSession,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(browser.location.href).toBe('http://127.0.0.1:5173/account');
    expect(setSession).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('locally signs out only when token establishment installed the attributable session', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#type=recovery&access_token=access&refresh_token=refresh',
    );
    const signOut = vi.fn(async () => ({ error: null }));

    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'access',
            user: { id: 'user-a', email: 'owner@example.test' },
          },
        },
        error: null,
      });

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession: vi.fn(async () => {
          throw new Error('transport failed after installing session');
        }),
        exchangeCodeForSession: vi.fn(),
        signOut,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('does not sign out a newer same-account session after token establishment throws', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#type=recovery&access_token=access&refresh_token=refresh',
    );
    const signOut = vi.fn(async () => ({ error: null }));
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'newer-token',
            user: { id: 'user-a', email: 'owner@example.test' },
          },
        },
        error: null,
      });

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession: vi.fn(async () => {
          throw new Error('transport failed after another session arrived');
        }),
        exchangeCodeForSession: vi.fn(),
        signOut,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(signOut).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('does not sign out an unattributable session after code exchange throws', async () => {
    const browser = browserAt('http://127.0.0.1:5173/account?type=recovery&code=recovery-code');
    const signOut = vi.fn(async () => ({ error: null }));
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'unrelated-token',
            user: { id: 'user-b', email: 'other@example.test' },
          },
        },
        error: null,
      });

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => {
          throw new Error('exchange failed without a returned session');
        }),
        signOut,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(signOut).not.toHaveBeenCalled();
  });

  it('cleans an invalid returned session only when its exact token is still current', async () => {
    const browser = browserAt('http://127.0.0.1:5173/account?type=recovery&code=recovery-code');
    const returnedSession = {
      access_token: 'returned-token',
      user: { id: '', email: '' },
    };
    const signOut = vi.fn(async () => ({ error: null }));
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({ data: { session: returnedSession }, error: null });

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => ({
          data: { session: returnedSession },
          error: new Error('invalid result'),
        })),
        signOut,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('preserves a newer session when an invalid returned callback session is stale', async () => {
    const browser = browserAt('http://127.0.0.1:5173/account?type=recovery&code=recovery-code');
    const signOut = vi.fn(async () => ({ error: null }));
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'newer-token',
            user: { id: 'user-b', email: 'other@example.test' },
          },
        },
        error: null,
      });

    await expect(
      consumeRecoveryCallback(browser, {
        getSession,
        setSession: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: 'returned-token',
              user: { id: '', email: '' },
            },
          },
          error: new Error('invalid result'),
        })),
        signOut,
      }),
    ).resolves.toMatchObject({ status: 'error' });

    expect(signOut).not.toHaveBeenCalled();
  });

  it('keeps cleanup best-effort when local sign-out itself throws', async () => {
    const browser = browserAt('http://127.0.0.1:5173/account?type=recovery&code=recovery-code');

    await expect(
      consumeRecoveryCallback(browser, {
        getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
        setSession: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => {
          throw new Error('establishment failed');
        }),
        signOut: vi.fn(() => {
          throw new Error('cleanup failed');
        }),
      }),
    ).resolves.toMatchObject({ status: 'error' });
  });

  it('fails closed instead of overwriting an existing signed-in account', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=secret&refresh_token=secret&type=recovery',
    );
    const setSession = vi.fn();

    await expect(
      consumeRecoveryCallback(browser, {
        getSession: vi.fn(async () => ({
          data: { session: { user: { id: 'user-b', email: 'other@example.test' } } },
          error: null,
        })),
        setSession,
        exchangeCodeForSession: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: 'error' });
    expect(setSession).not.toHaveBeenCalled();
  });

  it('cannot replay a callback after its URL material was consumed', async () => {
    const browser = browserAt(
      'http://127.0.0.1:5173/account#access_token=access&refresh_token=refresh&type=recovery',
    );
    const auth = {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      setSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: 'access',
            user: { id: 'user-a', email: 'owner@example.test' },
          },
        },
        error: null,
      })),
      exchangeCodeForSession: vi.fn(),
    };

    await consumeRecoveryCallback(browser, auth);
    await expect(consumeRecoveryCallback(browser, auth)).resolves.toEqual({ status: 'none' });
    expect(auth.setSession).toHaveBeenCalledOnce();
  });
});
