import { expect, it, vi } from 'vitest';
import { parseInstantCommand } from './parse';
import { executeInstantCommand } from './execute';
import { isComposerInstantCommandSource } from '@/features/chat/composerInstantCommand';
import { openCodeLaunchCommand } from './openCodeLaunch';
import { execFileSync } from 'node:child_process';

const source = `Hey please open opencode into a new terminal and then send this message 'Hi there' and click enter but make sure the model is at deepseek v4 flash from opencode go`;
it('pieces a complete request into one model-bound launch without a chat model', async () => {
  expect(isComposerInstantCommandSource(source)).toBe(true);
  const parsed = parseInstantCommand(source);
  expect(parsed).toMatchObject({
    kind: 'open-agent-cli',
    provider: 'opencode',
    count: 1,
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    prompt: 'Hi there',
  });
  const enqueueBatch = vi.fn((_commands: unknown) => ['launch-one']);
  const routeToTerminal = vi.fn();
  await expect(
    executeInstantCommand(parsed!, { enqueueBatch, routeToTerminal } as never),
  ).resolves.toMatchObject({ ok: true, code: 'queued' });
  expect(enqueueBatch).toHaveBeenCalledOnce();
  expect(enqueueBatch.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      target: 'new',
      preserveExisting: true,
      command: expect.stringContaining('--model'),
    }),
  ]);
  expect(routeToTerminal).toHaveBeenCalledOnce();
});

it('keeps shell metacharacters inside a literal PowerShell prompt', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  try {
    expect(
      openCodeLaunchCommand('opencode-go/deepseek-v4-flash-vision-exp', "Hi'; $(whoami); #"),
    ).toContain(
      "opencode --model 'opencode-go/deepseek-v4-flash-vision-exp' --prompt 'Hi''; $(whoami); #'",
    );
    expect(openCodeLaunchCommand('bad/model;whoami', 'Hi')).toBeNull();
    expect(openCodeLaunchCommand('good/model', 'Hi\nexit')).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

it.runIf(process.platform === 'win32')(
  'never sends a prompt when the exact model is missing',
  () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    try {
      const command = openCodeLaunchCommand('opencode-go/deepseek-v4-flash-vision-exp', 'Hi there');
      const script = `$script:sent = 0; function opencode { if ($args[0] -eq 'models') { $global:LASTEXITCODE = 0; 'opencode/other-model' } else { $script:sent++ } }; ${command}; Write-Output "SENT=$script:sent"`;
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(output).toContain('SENT=0');
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it.each([
  `explain how to open opencode and send 'Hi there' using model opencode-go/deepseek-v4-flash-vision-exp`,
  `do not open opencode and send 'Hi there' using model opencode-go/deepseek-v4-flash-vision-exp`,
  `open opencode and send 'Hi there' using model unknown`,
  `open opencode and send 'Hi there' using model opencode-go/deepseek-v4-flash-vision-exp and delete files`,
])('does not execute an ambiguous or non-command request: %s', (input) => {
  expect(parseInstantCommand(input)).toBeNull();
});
