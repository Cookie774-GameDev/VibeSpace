import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  projectId: null,
  apiKeys: {},
  defaultProvider: 'local',
}));
const uiState = vi.hoisted(() => ({
  setRoute: vi.fn(),
  notificationMaster: false,
  doneNotifications: { contextMaps: false },
}));

vi.mock('@/stores/auth', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  );
  return { useAuthStore };
});

vi.mock('@/stores/ui', () => {
  const useUIStore = Object.assign(
    (selector: (state: typeof uiState) => unknown) => selector(uiState),
    { getState: () => uiState },
  );
  return { useUIStore };
});

vi.mock('@/lib/accountIdentity', () => ({
  resolveAccountIdentity: () => ({ accountId: 'account-context-fixture' }),
}));

vi.mock('@/lib/notifications', () => ({
  notifyDone: vi.fn(),
  detectAndNotifyConnectorAuthLoss: vi.fn(),
}));

vi.mock('@/features/files/projectFiles', () => ({
  basename: (path: string) => path,
  chooseProjectFolder: vi.fn(),
  getStoredProjectRoot: () => '',
  setStoredProjectRoot: vi.fn(),
}));

vi.mock('@/lib/rightClickDrag', () => ({
  startRightClickDrag: vi.fn(),
}));

vi.mock('./ContextRecoveryNotice', () => ({
  ContextRecoveryNotice: () => null,
}));

vi.mock('./contextPersistence', () => ({
  deletePersistedContextMap: vi.fn(),
  ensureContextPersistence: vi.fn(() =>
    Promise.resolve({
      accountId: 'account-context-fixture',
      projectId: null,
      maps: [],
      recovery: null,
      selectedMapId: null,
    }),
  ),
  getActiveContextPersistenceState: () => null,
  savePersistedContextTree: vi.fn(),
  selectPersistedContextFile: vi.fn(),
  selectPersistedContextMap: vi.fn(),
}));

import { ContextPage } from './ContextPage';

describe('ContextPage MonoChrome appearance', () => {
  afterEach(cleanup);

  it('gates every rendered empty-state shadow, gradient, and blur without removing content', async () => {
    render(<ContextPage />);

    const heading = await screen.findByRole('heading', {
      name: 'Turn this project into an interactive AI context map.',
    });
    const route = heading.closest<HTMLElement>('[data-monochrome-route="context"]');
    expect(route).not.toBeNull();

    const shadowOwners = Array.from(
      route!.querySelectorAll<HTMLElement>('[class*="shadow"]'),
    ).filter(
      (owner) =>
        !owner.classList.contains('bg-accent-gradient') &&
        owner.className.split(/\s+/).some((className) => className.startsWith('shadow')),
    );
    expect(shadowOwners).toHaveLength(8);
    for (const owner of shadowOwners) {
      expect(owner.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    }

    const gradientOwners = route!.querySelectorAll<HTMLElement>('[class*="radial-gradient"]');
    expect(gradientOwners).toHaveLength(1);
    expect(gradientOwners[0]?.className).toContain('[html[data-theme=monochrome]_&]:bg-none');

    const blurOwners = Array.from(
      route!.querySelectorAll<HTMLElement>('[class*="backdrop-blur"]'),
    ).filter((owner) =>
      owner.className.split(/\s+/).some((className) => className.startsWith('backdrop-blur')),
    );
    expect(blurOwners).toHaveLength(2);
    for (const owner of blurOwners) {
      expect(owner.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
    }

    const hero = heading.parentElement?.parentElement?.parentElement;
    expect(blurOwners).toContain(hero);
    expect(hero?.firstElementChild).toBe(gradientOwners[0]);
    expect(screen.getByRole('button', { name: 'Create Context Map' })).toBeTruthy();
  });

  it('associates the visible project-folder label with the usable path input', async () => {
    render(<ContextPage />);

    const input = await screen.findByRole('textbox', { name: 'Project folder' });
    const label = screen.getByText('Project folder').closest('label');

    expect(label?.getAttribute('for')).toBe(input.id);
    fireEvent.change(input, { target: { value: 'C:\\workspace\\vibespace' } });
    expect((input as HTMLInputElement).value).toBe('C:\\workspace\\vibespace');
  });
});
