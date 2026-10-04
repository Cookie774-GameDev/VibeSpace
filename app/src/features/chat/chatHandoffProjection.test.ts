import { describe, expect, it } from 'vitest';
import type { Chat, Message, Part } from '@/types/chat';
import { projectChatHandoff, renderChatHandoffPrompt } from './chatHandoffProjection';

const sourceChat: Chat = {
  id: 'chat-source' as Chat['id'],
  workspace_id: 'workspace-1' as Chat['workspace_id'],
  project_id: 'project-1' as NonNullable<Chat['project_id']>,
  title: 'Build launch flow',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 1,
  updated_at: 2,
};

function message(id: string, createdAt: number, role: Message['role'], parts: Part[]): Message {
  return {
    id: id as Message['id'],
    chat_id: sourceChat.id,
    role,
    parts,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('safe chat handoff projection', () => {
  const now = new Date(2026, 7, 30, 12, 0, 0).getTime();
  const boundary = new Date(2026, 7, 28, 0, 0, 0).getTime();

  it('keeps the complete visible transcript from the most recent three calendar days', () => {
    const longText = `Complete recent detail ${'x'.repeat(18_000)} final marker`;
    const projection = projectChatHandoff({
      sourceChat,
      now,
      messages: [
        message('older', boundary - 1, 'user', [
          { kind: 'text', text: 'Old decision: ship blue.' },
        ]),
        message('boundary', boundary, 'user', [{ kind: 'text', text: longText }]),
        message('today', now - 1_000, 'assistant', [{ kind: 'text', text: 'Build completed.' }]),
      ],
    });

    expect(projection.boundaryAt).toBe(boundary);
    expect(projection.recentSections.map((section) => section.messageId)).toEqual([
      'boundary',
      'today',
    ]);
    expect(projection.recentSections[0].visibleText).toBe(longText);
    expect(projection.recentSections[0].chunks.join('')).toBe(longText);
    expect(projection.olderDigest).toContain('Old decision: ship blue.');
    expect(renderChatHandoffPrompt(projection, 'Please continue this work.')).toContain(
      'final marker',
    );
    expect(renderChatHandoffPrompt(projection, 'Please continue this work.')).toContain(
      `Last meaningful activity: ${projection.lastMeaningfulActivity}`,
    );
  });

  it('excludes private reasoning, secrets, raw tool payloads, and binary bytes', () => {
    const projection = projectChatHandoff({
      sourceChat,
      now,
      messages: [
        message('safe', now - 2_000, 'assistant', [
          { kind: 'reasoning', text: 'hidden chain-of-thought' },
          { kind: 'text', text: 'Goal: finish the launch. API_KEY=super-secret-value' },
          {
            kind: 'tool_call',
            tool: 'write_file',
            call_id: 'call-1',
            args: { path: 'src/app.ts', token: 'raw-secret-token' },
          },
          {
            kind: 'tool_result',
            call_id: 'call-1',
            result: { bytes: [1, 2, 3], secret: 'raw-secret' },
          },
          { kind: 'image', url: 'data:image/png;base64,BINARY-BYTES', alt: 'screen' },
          { kind: 'file_ref', ref: { kind: 'file', id: 'src/app.ts' } },
          {
            kind: 'action_proposal',
            call_id: 'action-1',
            action_id: 'nav.goto',
            params: { secret: 'raw-action-secret' },
            rationale: 'Open the Schedule page.',
            status: 'success',
          },
        ]),
      ],
    });
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toMatch(/chain-of-thought|super-secret-value|raw-secret|BINARY-BYTES/);
    expect(projection.goal).toBe('finish the launch. [REDACTED]');
    expect(projection.summaries.files).toEqual(['src/app.ts']);
    expect(projection.summaries.tools).toEqual(['write_file — completed']);
    expect(projection.summaries.actions).toEqual(['nav.goto — success — Open the Schedule page.']);
  });

  it('redacts standalone credentials and credential-bearing metadata before projection', () => {
    const stripeFixture = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_');
    const githubFixture = `ghp_${'1234567890abcdefghijklmnopqrstuv'}`;
    const awsFixture = `AKIA${'1234567890ABCDEF'}`;
    const projection = projectChatHandoff({
      sourceChat: {
        ...sourceChat,
        title: `Deploy ${stripeFixture}`,
      },
      now,
      messages: [
        message('credentials', now - 2_000, 'assistant', [
          {
            kind: 'text',
            text: `Use ${githubFixture} and ${awsFixture}.`,
          },
          {
            kind: 'tool_call',
            tool: `fetch_${githubFixture}`,
            call_id: 'call-secret',
            args: {},
          },
          {
            kind: 'file_ref',
            ref: {
              kind: 'file',
              id: `C:/tmp/${['sk', 'test', '1234567890abcdefghijklmnop'].join('_')}.txt`,
            },
          },
          {
            kind: 'jarvis_source_ref',
            source: {
              id: 'source-secret',
              kind: 'web',
              label: 'signed download',
              uri: 'https://example.test/file?X-Amz-Signature=0123456789abcdef&token=plain-secret',
              trust: 'external_untrusted',
              sensitivity: 'public',
            },
          },
        ]),
      ],
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(
      /sk_live_|sk_test_|ghp_123|AKIA123|0123456789abcdef|plain-secret/,
    );
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts namespaced OpenAI/Anthropic keys and stack labels', () => {
    const openAiFixture = `sk-proj-${'abcdefghijklmnopqrstuvwx'}`;
    const anthropicFixture = `sk-ant-api03-${'abcdefghijklmnopqrstuvwx'}`;
    const projection = projectChatHandoff({
      sourceChat,
      now,
      messages: [
        message('provider-credentials', now - 1_500, 'assistant', [
          {
            kind: 'text',
            text: `OPENAI_API_KEY=${openAiFixture}\nANTHROPIC_API_KEY=${anthropicFixture}`,
          },
          {
            kind: 'stack_step',
            step_id: 'step-1',
            label: `deploy ${anthropicFixture}`,
            provider: 'openai',
            model: 'test-model',
            text: 'Safe progress',
            status: 'done',
          },
        ]),
      ],
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(openAiFixture);
    expect(serialized).not.toContain(anthropicFixture);
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
  });

  it('reports tool and action outcomes truthfully without raw payloads', () => {
    const projection = projectChatHandoff({
      sourceChat,
      now,
      messages: [
        message('outcomes', now - 1_000, 'assistant', [
          { kind: 'tool_call', tool: 'deploy', call_id: 'tool-error', args: {} },
          {
            kind: 'tool_result',
            call_id: 'tool-error',
            error: 'Deployment failed: bearer abcdefghijklmnop',
          },
          { kind: 'tool_call', tool: 'echo_secret', call_id: 'tool-string', args: {} },
          {
            kind: 'tool_result',
            call_id: 'tool-string',
            result: 'raw string payload must never enter the handoff',
          },
          {
            kind: 'action_proposal',
            call_id: 'action-error',
            action_id: 'nav.goto',
            params: {},
            status: 'error',
            error: 'Blocked by policy',
          },
          {
            kind: 'action_proposal',
            call_id: 'action-success',
            action_id: 'files.write',
            params: {},
            status: 'success',
            result: { summary: 'Wrote src/app.ts', secret: 'must-not-leak' },
          },
        ]),
      ],
    });

    expect(projection.summaries.tools).toEqual([
      'deploy — error: Deployment failed: [REDACTED]',
      'echo_secret — completed',
    ]);
    expect(projection.summaries.actions).toContain('nav.goto — error: Blocked by policy');
    expect(projection.summaries.actions).toContain('files.write — success: Wrote src/app.ts');
    expect(projection.summaries.blockers).toContain(
      'deploy — error: Deployment failed: [REDACTED]',
    );
    expect(projection.summaries.results).toContain('files.write — success: Wrote src/app.ts');
    expect(JSON.stringify(projection)).not.toContain('must-not-leak');
    expect(JSON.stringify(projection)).not.toContain('raw string payload');
  });

  it('renders the exact snapshot and three-day boundary metadata', () => {
    const projection = projectChatHandoff({ sourceChat, now, messages: [] });
    const prompt = renderChatHandoffPrompt(projection, 'Continue.');

    expect(prompt).toContain(`Snapshot at: ${now}`);
    expect(prompt).toContain(`Three-day boundary at: ${boundary}`);
    expect(prompt).toContain('Boundary message: none');
  });

  it('deduplicates repeated visible fragments by stable message/part content', () => {
    const projection = projectChatHandoff({
      sourceChat,
      now,
      messages: [
        message('streamed', now - 5_000, 'assistant', [
          { kind: 'text', text: 'Same streamed fragment' },
          { kind: 'text', text: 'Same streamed fragment' },
          { kind: 'text', text: 'New final fragment' },
        ]),
      ],
    });

    expect(projection.recentSections[0].visibleText).toBe(
      'Same streamed fragment\n\nNew final fragment',
    );
    expect(projection.boundaryMessageId).toBe('streamed');
    expect(projection.lastMeaningfulActivity).toContain('New final fragment');
  });
});
