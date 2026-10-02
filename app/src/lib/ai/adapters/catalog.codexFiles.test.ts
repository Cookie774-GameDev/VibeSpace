import { expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { createCodexPersistentAdapter } from '@/lib/ai/adapters/codexPersistent';
import { selectionFromOption, validateSendModelAccess } from '@/lib/ai/modelSelection';
import { getExplicitFilesBlock } from '@/lib/ai/context';

const fsMock = vi.hoisted(() => ({ readTextFileSample: vi.fn() }));
vi.mock('@/lib/fs', async (original) => ({
  ...(await original<typeof import('@/lib/fs')>()),
  readTextFileSample: fsMock.readTextFileSample,
}));
const connection = CODEX_CLI_CONNECTION;
const attachmentCode = 'S61-ATTACHMENT-73';

it('allows bounded text-file context through the actual Codex descriptor without enabling images', () => {
  const selection = selectionFromOption('openai', 'gpt-5.6-luna', connection);
  const context = {
    apiKeys: {},
    offlineMode: false,
    plan: 'free' as const,
    defaultLocalModel: 'llama3.2',
  };
  expect(
    validateSendModelAccess('Read the attached text file.', selection, context, [], {
      attachments: { hasFiles: true },
    }),
  ).toEqual({ ok: true });
  expect(connection.capabilities.images).toBe(false);
  expect(
    validateSendModelAccess('Describe the attached image.', selection, context, [], {
      attachments: { hasImages: true },
    }),
  ).toEqual({ ok: false, message: 'The selected connection does not support image attachments.' });
  expect(connection.toolAllowlist).toEqual(['vibespace_context']);
});

async function* frames(usageUpdates: Array<Record<string, unknown>> = []) {
  yield {
    id: 'request_1_model_1',
    result: {
      data: [
        {
          model: 'gpt-5.6-luna',
          supportedReasoningEfforts: [],
          serviceTiers: [],
        },
      ],
      nextCursor: null,
    },
  };
  yield {
    id: 'request_1_thread',
    result: {
      thread: { id: 'thread_native_1' },
      model: 'gpt-5.6-luna',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: 'C:\\workspace',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: null,
    },
  };
  yield {
    method: 'turn/started',
    params: {
      threadId: 'thread_native_1',
      turn: { id: 'turn_native_1' },
    },
  };
  yield {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      itemId: 'message_native_1',
      delta: 'Working on it.',
    },
  };
  yield {
    method: 'item/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      item: {
        id: 'command_native_1',
        type: 'commandExecution',
        status: 'completed',
        commandActions: [{ type: 'read', path: 'C:\\workspace\\game.js' }],
        exitCode: 0,
      },
    },
  };
  for (const tokenUsage of usageUpdates) {
    yield {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread_native_1',
        turnId: 'turn_native_1',
        tokenUsage,
      },
    };
  }
  yield {
    method: 'turn/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    },
  };
}

it.each([false, true])(
  'transports bounded policy-checked attached text on real Codex frames (resume=%s)',
  async (resume) => {
    fsMock.readTextFileSample.mockResolvedValue({
      ok: true,
      path: 'C:\\workspace\\attachment.txt',
      content: attachmentCode + '\n' + 'x'.repeat(20000),
    });
    const attachedContext = await getExplicitFilesBlock(
      ['C:\\workspace\\attachment.txt'],
      'C:\\workspace',
    );
    expect(fsMock.readTextFileSample).toHaveBeenCalledWith(
      'C:\\workspace\\attachment.txt',
      64 * 1024,
      { root: 'C:\\workspace' },
    );
    expect(attachedContext).toContain(attachmentCode);
    expect(attachedContext).toContain('(truncated)');
    expect(attachedContext.length).toBeLessThan(18000);
    const writes: Array<Record<string, unknown>> = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          for await (const frame of frames()) {
            yield resume && 'id' in frame && frame.id === 'request_1_thread'
              ? { ...frame, id: 'request_1_resume' }
              : frame;
            if (resume && 'id' in frame && frame.id === 'request_1_thread') {
              yield { id: 'request_1_policy', result: {} };
            }
          }
        })(),
      }),
      write: async (_generation, message) => {
        writes.push(message);
      },
      stop: async () => true,
    });
    for await (const _ of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute: {
        kind: 'official-codex',
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-luna',
      },
      chatId: 'chat',
      prompt: 'Read the files and make an HTML.',
      historyPrompt: 'Earlier conversation. Read the files and make an HTML.',
      systemPrompt: 'Application policy and selected Ponytail skill.\n' + attachedContext,
      modelId: 'gpt-5.6-luna',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      ...(resume ? { sessionId: 'thread_native_1' } : {}),
    })) {
      /* Consume the real adapter event path. */
    }
    expect(writes[1]).toMatchObject({ params: { developerInstructions: expect.any(String) } });
    const instructions = (writes[1].params as { developerInstructions: string })
      .developerInstructions;
    expect(instructions).toContain(attachedContext);
    expect(instructions).toContain('Application policy and selected Ponytail skill.');
    expect(instructions).toContain('Do not replace those tools with textual files.create');
    expect(instructions).toContain('Ask and Plan remain read-only');
    expect(instructions).toContain('Finish the response after such a proposal');
    if (resume) {
      expect(writes[2].id).toBe('request_1_policy');
      expect(writes[2].params).toMatchObject({ threadId: 'thread_native_1' });
    }
    const turn = writes.find((message) => message.method === 'turn/start')!;
    expect(turn).toMatchObject({ params: { input: [{ text: expect.any(String) }] } });
    const userText = (turn.params as { input: Array<{ text: string }> }).input[0].text;
    if (resume) {
      expect(userText).toBe('Read the files and make an HTML.');
    } else {
      expect(userText).toContain('historical reference only');
      expect(userText).toContain(
        JSON.stringify('Earlier conversation. Read the files and make an HTML.'),
      );
      expect(userText.endsWith('CURRENT REQUEST:\nRead the files and make an HTML.')).toBe(true);
    }
    expect(userText).not.toContain('Application policy');
  },
);
