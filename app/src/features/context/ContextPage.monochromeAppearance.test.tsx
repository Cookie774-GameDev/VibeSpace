import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const chooseProjectFolder = vi.hoisted(() => vi.fn());

vi.mock('@/stores/auth', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  );
  return { useAuthStore };
});

vi.mock('@/stores/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/ui')>();
  const useUIStore = Object.assign(
    (selector: (state: typeof uiState) => unknown) => selector(uiState),
    { getState: () => uiState },
  );
  return { ...actual, useUIStore };
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
  chooseProjectFolder,
  chooseProjectFiles: vi.fn(async () => []),
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
  afterEach(() => {
    cleanup();
    chooseProjectFolder.mockReset();
  });

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

    const input = await screen.findByRole('textbox', { name: 'Context source folder' });
    const label = screen.getByText('Context source folder').closest('label');

    expect(label?.getAttribute('for')).toBe(input.id);
    fireEvent.change(input, { target: { value: 'C:\\workspace\\vibespace' } });
    expect((input as HTMLInputElement).value).toBe('C:\\workspace\\vibespace');
  });

  it('keeps a long selected summary path inside the panel with ellipsis and full hover text', async () => {
    render(<ContextPage />);
    const path =
      '\\\\?\\C:\\Users\\viper\\Documents\\AccessRevamp Campaigns\\AR-OUTREACH\\campaigns\\enterprise\\contacts\\prospects.csv';
    const input = await screen.findByPlaceholderText('Paste one or more file paths (one per line)');

    fireEvent.change(input, { target: { value: path } });
    fireEvent.click(screen.getByRole('button', { name: 'Add pasted path' }));

    const label = screen.getByTitle(path);
    expect(label.textContent).toBe(path);
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('text-[10px]');
    expect(label.parentElement?.className).toContain('w-full');
    expect(label.parentElement?.className).toContain('max-w-full');
    expect(label.parentElement?.className).toContain('overflow-hidden');
  });

  it('adds a picked folder root to the real selected summary scope', async () => {
    const folder = '\\\\?\\C:\\Users\\viper\\projects\\aether-drift\\src';
    chooseProjectFolder.mockResolvedValueOnce(folder);
    render(<ContextPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add folders' }));

    await waitFor(() => expect(screen.getByTitle(folder)).toBeTruthy());
    expect(screen.getByText('1 selected summary path')).toBeTruthy();
  });
});
