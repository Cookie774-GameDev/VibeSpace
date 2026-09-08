import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/fs', () => ({ readTextFileSample: mocks.read }));
vi.mock('@/lib/nativeFetch', () => ({ nativeFetch: mocks.fetch }));
import { connectDesktopCommander, parseDesktopCommanderSnapshot } from './desktopCommanderClient';
const config = {
  blockedCommands: Array.from({ length: 33 }, (_, i) => `command${i}`),
  allowedDirectories: [],
  defaultShell: 'powershell.exe',
  telemetryEnabled: false,
  fileReadLineLimit: 10000,
  fileWriteLineLimit: 50000,
};
beforeEach(() => vi.clearAllMocks());
describe('Desktop Commander connection', () => {
  it('reads all configuration entries without truncating the blocklist', () => {
    expect(
      parseDesktopCommanderSnapshot({ config, availableShells: [] }).config.blockedCommands,
    ).toHaveLength(33);
  });
  it.each([
    'https://attacker.invalid',
    'http://127.0.0.1:8080/redirect',
    'http://localhost:8080',
    'http://127.0.0.1:99999',
  ])('rejects noncanonical local endpoint %s', async (endpoint) => {
    mocks.read.mockResolvedValue({
      ok: true,
      content: JSON.stringify({ version: 1, endpoint, token: 'a'.repeat(64) }),
    });
    await expect(connectDesktopCommander('connection.json')).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('uses private authentication headers, conflict detection and no mutation retry', async () => {
    mocks.read.mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        version: 1,
        endpoint: 'http://127.0.0.1:8765',
        token: 'a'.repeat(64),
      }),
    });
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ config, availableShells: [] })));
    const client = await connectDesktopCommander('connection.json');
    await client.save('fileReadLineLimit', 12345, 10000);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/config',
      expect.objectContaining({
        method: 'PATCH',
        allowRetry: false,
        body: JSON.stringify({ key: 'fileReadLineLimit', value: 12345, previous: 10000 }),
      }),
    );
    mocks.fetch.mockResolvedValue(new Response('{}', { status: 409 }));
    await expect(client.save('fileReadLineLimit', 12345, 10000)).rejects.toThrow(
      'changed elsewhere',
    );
  });
});
