import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Workbench upgrade contracts', () => {
  it('uses the native fullscreen store and exposes edge reveal without showing the toolbar', () => {
    const page = readFileSync(join(__dirname, 'WorkbenchPage.tsx'), 'utf8');
    const styles = readFileSync(join(__dirname, 'workbench.css'), 'utf8');

    expect(page).toContain('useFullscreenStore');
    expect(page).toContain('Toggle system fullscreen');
    expect(page).toContain('data-system-fullscreen');
    expect(page).toContain('data-palette-revealed');
    expect(page).toContain('const WORKBENCH_PALETTE_REVEAL_PX = 72');
    expect(page).toContain('event.clientX <= WORKBENCH_PALETTE_REVEAL_PX');
    expect(styles).toMatch(/\[data-system-fullscreen='true'\][^{]*\.workbench-toolbar/);
    expect(styles).toMatch(/\[data-palette-revealed='true'\][^{]*\.workbench-palette/);
    expect(styles).toMatch(/\.workbench-system-fullscreen-exit\s*\{[^}]*right:\s*206px;/s);
  });

  it('maps actions, tools, plugins, and plugin dashboards to independent surfaces', () => {
    const surface = readFileSync(join(__dirname, 'EmbeddedSurface.tsx'), 'utf8');
    const palette = readFileSync(join(__dirname, 'PanelPalette.tsx'), 'utf8');

    expect(surface).toContain('JarvisActions');
    expect(surface).toContain('Plugins');
    expect(surface).toContain('ToolsPage');
    expect(surface).toContain('PluginDashboardPanel');
    expect(palette).toContain("kind: 'tools'");
    expect(palette).not.toContain("{ kind: 'github'");
    expect(palette).not.toContain("{ kind: 'supabase'");
  });

  it('applies brightness only to the wallpaper layer and exposes a 0-100 control', () => {
    const host = readFileSync(join(__dirname, 'WallpaperHost.tsx'), 'utf8');
    const picker = readFileSync(join(__dirname, 'WallpaperPicker.tsx'), 'utf8');
    const styles = readFileSync(join(__dirname, 'workbench.css'), 'utf8');

    expect(host).toContain("'--wallpaper-brightness'");
    expect(picker).toContain('Wallpaper brightness');
    expect(picker).toMatch(/max="100"/);
    expect(styles).toContain('var(--wallpaper-brightness');
  });
});
