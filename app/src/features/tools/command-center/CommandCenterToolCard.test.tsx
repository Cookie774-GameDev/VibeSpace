import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./commandCenterTool', () => ({
  readCommandCenterReleaseAuthority: () => ({
    url: 'https://example.com/tool.exe',
    sha256: 'a'.repeat(64),
    version: '1.0.0',
  }),
  inspectCommandCenterTool: vi.fn(async () => ({
    installed: false,
    executablePath: null,
    installerReady: false,
    phase: 'idle',
    detail: null,
  })),
  downloadCommandCenterTool: vi.fn(),
  installCommandCenterTool: vi.fn(),
  launchCommandCenterTool: vi.fn(),
  cancelCommandCenterToolDownload: vi.fn(),
  onCommandCenterDownloadProgress: vi.fn(async () => () => {}),
}));

import { CommandCenterToolCard } from './CommandCenterToolCard';
import {
  inspectCommandCenterTool,
  downloadCommandCenterTool,
  launchCommandCenterTool,
} from './commandCenterTool';

describe('Codex Command Center preloaded tool card', () => {
  afterEach(cleanup);

  it('is preloaded and coming soon without inspecting, downloading or launching', () => {
    render(<CommandCenterToolCard />);
    expect(screen.getByRole('heading', { name: 'Codex Command Center' })).toBeTruthy();
    expect(screen.getByText('Preloaded')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Coming soon' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(inspectCommandCenterTool).not.toHaveBeenCalled();
    expect(downloadCommandCenterTool).not.toHaveBeenCalled();
    expect(launchCommandCenterTool).not.toHaveBeenCalled();
    expect(screen.getByText(/progress, daily goals, and milestones/i)).toBeTruthy();
  });
});
