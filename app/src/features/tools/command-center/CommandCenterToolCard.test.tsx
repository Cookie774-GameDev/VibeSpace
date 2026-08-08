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

describe('Codex Command Center preloaded tool card', () => {
  afterEach(cleanup);

  it('presents the exact product name and an explicit download action', async () => {
    render(<CommandCenterToolCard />);
    expect(screen.getByRole('heading', { name: 'Codex Command Center' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getByText(/progress, daily goals, and milestones/i)).toBeTruthy();
  });
});
