import { describe, expect, it, vi } from 'vitest';
import { resolveCodexWorkingDirectory } from './codexWorkingDirectory';

function dependencies() {
  return {
    appData: vi.fn(async () => 'C:/app-data'),
    join: vi.fn(async (...paths: string[]) => paths.join('/')),
    create: vi.fn(async () => ({ ok: true })),
  };
}

describe('Codex chat working directory', () => {
  it('preserves an explicit project without creating a fallback', async () => {
    const deps = dependencies();
    expect(await resolveCodexWorkingDirectory('D:/project', deps)).toBe('D:/project');
    expect(deps.appData).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])('prepares the app-owned folder for %s', async (selected) => {
    const deps = dependencies();
    const path = await resolveCodexWorkingDirectory(selected, deps);
    expect(path).toBe('C:/app-data/harness/codex-server/workspace');
    expect(deps.create).toHaveBeenCalledWith(path, { root: 'C:/app-data' });
  });

  it('fails before launch when directory preparation fails', async () => {
    const deps = dependencies();
    deps.create.mockResolvedValue({ ok: false });
    await expect(resolveCodexWorkingDirectory(undefined, deps)).rejects.toThrow(
      'could not be prepared',
    );
  });
});
