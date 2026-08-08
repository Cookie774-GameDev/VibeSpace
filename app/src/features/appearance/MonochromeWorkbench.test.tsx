import { fireEvent, render, screen, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Avatar } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';

const WORKBENCH_PATH = path.resolve(
  process.cwd(),
  'src/features/appearance/MonochromeWorkbench.tsx',
);

const EXPECTED_PRIMITIVES = [
  'Avatar',
  'Badge',
  'Button',
  'Card',
  'Checkbox',
  'Dialog',
  'Input',
  'Label',
  'Popover',
  'Separator',
  'Skeleton',
  'Switch',
  'Tabs',
  'Textarea',
  'Toast',
  'Tooltip',
] as const;

const EXPECTED_STATES = [
  'default',
  'hover',
  'active',
  'focus-visible',
  'disabled',
  'validation-error',
  'checked',
  'selected',
  'open',
  'loading',
  'destructive',
  'keyboard',
  'screen-reader',
] as const;

async function loadWorkbench() {
  return import('./MonochromeWorkbench');
}

describe('MonoChrome development workbench', () => {
  it('exists as an owned workbench module', () => {
    expect(existsSync(WORKBENCH_PATH)).toBe(true);
  });

  it('requires both a development build and the explicit query', async () => {
    const { isMonochromeWorkbenchRequest, MonochromeWorkbench } = await loadWorkbench();

    expect(
      isMonochromeWorkbenchRequest({
        devBuild: true,
        search: '?monochrome-workbench=1',
      }),
    ).toBe(true);
    expect(
      isMonochromeWorkbenchRequest({
        devBuild: false,
        search: '?monochrome-workbench=1',
      }),
    ).toBe(false);
    expect(isMonochromeWorkbenchRequest({ devBuild: true, search: '' })).toBe(false);
    expect(
      isMonochromeWorkbenchRequest({
        devBuild: true,
        search: '?monochrome-workbench=true',
      }),
    ).toBe(false);

    const productionView = render(
      <MonochromeWorkbench devBuild={false} search="?monochrome-workbench=1" />,
    );
    expect(productionView.container.childElementCount).toBe(0);
  }, 10_000);

  it('uses an exact development-only lazy entry without joining routes or navigation', () => {
    const mainSource = readFileSync(path.resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    const developmentEntrySource = readFileSync(
      path.resolve(process.cwd(), 'src/developmentEntry.tsx'),
      'utf8',
    );
    const developmentSurfaceSource = readFileSync(
      path.resolve(process.cwd(), 'src/developmentSurface.ts'),
      'utf8',
    );
    expect(mainSource).toMatch(/import\.meta\.env\.DEV/u);
    expect(developmentSurfaceSource).toMatch(/monochrome-workbench/u);
    expect(mainSource).toMatch(/import\(['"]\.\/developmentEntry['"]\)/u);
    expect(mainSource).not.toMatch(/MonochromeWorkbench|monochromeWorkbenchFixtures/u);
    expect(mainSource).toMatch(/document\.documentElement\.dataset\.theme = ['"]monochrome['"]/u);
    expect(developmentEntrySource).toMatch(
      /import\(['"]\.\/features\/appearance\/MonochromeWorkbench['"]\)/u,
    );

    for (const relativePath of [
      'src/App.tsx',
      'src/components/layout/PageRouter.tsx',
      'src/components/layout/NavPane.tsx',
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/MonochromeWorkbench/u);
      expect(source, relativePath).not.toMatch(/monochrome-workbench/u);
    }
  });

  it('renders every frozen shared primitive and approved surface from fixtures', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    const view = render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);

    for (const primitive of EXPECTED_PRIMITIVES) {
      expect(
        view.container.querySelector(`[data-monochrome-primitive="${primitive}"]`),
        primitive,
      ).not.toBeNull();
    }

    const fixtureModule = await import('./monochromeWorkbenchFixtures');
    for (const surface of fixtureModule.MONOCHROME_WORKBENCH_SURFACE_IDS) {
      expect(
        view.container.querySelector(`[data-workbench-surface="${surface}"]`),
        surface,
      ).not.toBeNull();
    }
  });

  it('renders the synthetic operator avatar with a solid local treatment', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    const view = render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);
    const avatar = view.container.querySelector<HTMLElement>(
      '[data-monochrome-primitive="Avatar"]',
    );

    expect(avatar).not.toBeNull();
    expect(avatar?.style.backgroundImage).toBe('none');
    expect(avatar?.style.backgroundColor).toBe('hsl(var(--accent-cyan))');

    const defaultView = render(<Avatar seed="shared-default" initials="SD" />);
    const defaultAvatar = defaultView.container.querySelector<HTMLElement>(
      '[data-vibespace-avatar="true"]',
    );
    expect(defaultAvatar?.style.background).toBe(
      'var(--vibespace-avatar-background, var(--vibespace-avatar-gradient))',
    );
    expect(defaultAvatar?.style.backgroundImage).toBe('');
  });

  it('renders the loading fixture with a solid local treatment', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    const view = render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);
    const skeleton = view.container.querySelector<HTMLElement>(
      '[data-monochrome-primitive="Skeleton"]',
    );

    expect(skeleton).not.toBeNull();
    expect(skeleton?.style.backgroundImage).toBe('none');
    expect(skeleton?.style.backgroundColor).toBe('hsl(var(--muted))');
  });

  it('removes the checked Switch thumb shadow only inside the development fixture', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);

    expect(screen.getByRole('switch', { name: 'Deterministic mode' }).className).toContain(
      '[&>span]:shadow-none',
    );

    const defaultView = render(<Switch aria-label="Shared default switch" defaultChecked />);
    expect(
      defaultView.getByRole('switch', { name: 'Shared default switch' }).querySelector('span')
        ?.className,
    ).toContain('shadow-lg');
  });

  it('exposes the complete state vocabulary without removing native semantics', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    const view = render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);

    for (const state of EXPECTED_STATES) {
      expect(
        view.container.querySelector(`[data-workbench-state~="${state}"]`),
        state,
      ).not.toBeNull();
    }

    expect(screen.getByRole('heading', { name: 'MonoChrome primitive workbench' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Workbench sections' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Synthetic agent activity' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Context budget' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Response detail' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Local runtime' })).toBeTruthy();
  });

  it('supports named keyboard-operable controls and visible interactive outcomes', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);

    const checkbox = screen.getByRole('checkbox', { name: 'Include repository context' });
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: ' ' });
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute('data-state')).toBe('checked');

    fireEvent.click(screen.getByRole('button', { name: 'Open environment menu' }));
    expect(screen.getByRole('menu', { name: 'Environment menu' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Staging cluster' }));
    expect(screen.getByText('Environment: Staging cluster')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review access policy' }));
    const dialog = screen.getByRole('dialog', { name: 'Review access policy' });
    expect(dialog).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Publish fixture' }));
    const alert = await screen.findByText('Fixture published');
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByRole('tabpanel', { name: 'Terminal' })).toBeTruthy();
  });

  it('labels validation, disabled, loading, destructive, and empty states', async () => {
    const { MonochromeWorkbench } = await loadWorkbench();
    render(<MonochromeWorkbench devBuild search="?monochrome-workbench=1" />);

    const form = screen.getByRole('form', { name: 'Prompt run configuration' });
    expect(within(form).getByLabelText('Run name').getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByText('Use at least three characters.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Syncing fixture' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete synthetic run' })).toBeTruthy();
    expect(screen.getByText('No pinned contexts')).toBeTruthy();
    expect(screen.getByText('Synthetic fixtures only')).toBeTruthy();
  });
});
