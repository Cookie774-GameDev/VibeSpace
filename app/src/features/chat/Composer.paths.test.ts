import { describe, expect, it } from 'vitest';
import type { Agent } from '@/types';
import type { AgentId } from '@/types/common';
import {
  buildConfirmedAgentMention,
  buildSlashReferenceCommand,
  canvasSnapshotToImageAttachment,
  connectionSupportsFileAttachments,
  extractAbsoluteFilePaths,
  resolveSendFilePaths,
  getAppearanceCommandHelp,
  getQueuedMessageNotice,
  getThemeCommandHelp,
  mergeActiveCanvasSourcesForPromptForge,
  resolveCanvasAttachmentModesForSend,
  resolveMentionedAgentIdsForSend,
} from './Composer';
import { findSlashCommandDef } from './SlashCommandTypeahead';
import { buildVibeSpaceReferenceRequest } from './slashCommandRouting';
import { compileCanvasAiContext } from '@/features/canvas/aiContext';
import {
  clearActiveCanvasAiContextForTests,
  publishActiveCanvasAiContextProvider,
} from '@/features/canvas/aiContextRegistry';
import { createCanvasDocument } from '@/features/canvas/contracts';

function agent(id: string, slug: string): Agent {
  return {
    id: id as AgentId,
    slug,
    name: slug,
    description: `${slug} description`,
    system_prompt: `${slug} prompt`,
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('composer file path detection', () => {
  it('extracts a Windows path with spaces from a natural-language request', () => {
    expect(
      extractAbsoluteFilePaths(
        'C:\\Users\\dev\\Documents\\project\\Scripts\\Editor\\context_map.json please summarize this',
      ),
    ).toEqual(['C:\\Users\\dev\\Documents\\project\\Scripts\\Editor\\context_map.json']);
  });

  it('deduplicates repeated file paths', () => {
    const path = 'C:\\project\\AnimalOutputGenerator.cs';
    expect(extractAbsoluteFilePaths(`${path} summarize ${path}`)).toEqual([path]);
  });

  it('keeps typed Windows paths as text on connections that cannot attach files', () => {
    const sendText =
      'Read these with files.read\nC:\\Users\\viper\\Downloads\\VibeSpace-Test03-Ten-Files-20260814-Grok4\\01_readme.txt';
    expect(
      resolveSendFilePaths({
        attachedFiles: [],
        sendText,
        supportsFiles: false,
      }),
    ).toEqual([]);
    expect(
      resolveSendFilePaths({
        attachedFiles: [],
        sendText,
        supportsFiles: true,
      }),
    ).toEqual([
      'C:\\Users\\viper\\Downloads\\VibeSpace-Test03-Ten-Files-20260814-Grok4\\01_readme.txt',
    ]);
  });

  it('still sends an explicit /attach path even when the connection cannot attach files', () => {
    expect(
      resolveSendFilePaths({
        attachedFiles: ['C:\\Users\\viper\\notes.txt'],
        sendText: 'Please review the attached notes.',
        supportsFiles: false,
      }),
    ).toEqual(['C:\\Users\\viper\\notes.txt']);
  });

  it('treats openai-codex as a no-file-attachment connection', () => {
    expect(
      connectionSupportsFileAttachments({
        mode: 'single',
        connectionId: 'openai-codex',
        capabilities: { files: false },
      }),
    ).toBe(false);
  });
});

describe('composer queued-run notice', () => {
  it('offers explicit stop/restart or next-turn behavior for an in-flight model switch', () => {
    expect(getQueuedMessageNotice('Use the fastest connected model.')).toEqual({
      title: 'Model switch queued',
      body: 'The current reply keeps its captured model. Leave this queued to review and apply on the next turn, or stop the current reply and resend to restart sooner.',
    });
  });

  it('keeps mode-specific queue notices for ordinary follow-up messages', () => {
    expect(getQueuedMessageNotice('Summarize the result next.', 'after-run')).toEqual({
      title: 'Message queued',
      body: 'It will send when this reply fully finishes (Tab). Esc sends now · Esc×3 cancels the run.',
    });
    expect(getQueuedMessageNotice('Nudge after tool.', 'after-tool').body).toMatch(/tool/i);
  });
});

describe('composer mention and slash confirmation helpers', () => {
  it('turns a schedule request into bounded VibeSpace context instead of raw slash syntax', () => {
    const request = buildVibeSpaceReferenceRequest('schedule', 'run npm test tomorrow');
    expect(request).toBe(
      'Context references: /schedule references Schedule. User request: run npm test tomorrow',
    );
    expect(request).not.toMatch(/^\/schedule\b/u);
  });

  it('separates console profiles from the release-only global appearance picker', () => {
    expect(getThemeCommandHelp()).toBe(
      'Chat console themes: Paper White, Solar Sand, Sakura Mist, Icebound, VibeSpace Amber, Graphite, Midnight Blue, Monokai Ember, Matrix Moss, OLED Void. Use /theme <name>.',
    );
    expect(getAppearanceCommandHelp()).toBe(
      'Available appearances: Jarvis One, Default, MonoChrome, Warm. Use /appearance to choose.',
    );
  });

  it('resolves selected mention tokens together with typed @agent mentions', () => {
    const builder = agent('agent_builder', 'builder');
    const reviewer = agent('agent_reviewer', 'reviewer');

    expect(
      resolveMentionedAgentIdsForSend(
        '@builder summarize this',
        { [builder.id]: builder, [reviewer.id]: reviewer },
        [buildConfirmedAgentMention(reviewer)],
      ),
    ).toEqual([reviewer.id, builder.id]);
  });

  it('turns page slash commands into chat reference tokens instead of navigation intents', () => {
    const agents = findSlashCommandDef('agents');
    const terminals = findSlashCommandDef('terminals');
    // Hive is product-gated off by default — no reference token surface.
    const hive = findSlashCommandDef('hive');

    expect(agents && buildSlashReferenceCommand(agents)).toMatchObject({
      cmd: 'agents',
      label: '/agents: Agents page/editor',
      value: 'reference:agents',
    });
    expect(terminals && buildSlashReferenceCommand(terminals)).toMatchObject({
      cmd: 'terminals',
      label: '/terminals: Terminal surface',
      value: 'reference:terminals',
    });
    expect(hive).toBeUndefined();
  });

  it('resolves explicit Canvas picker and slash references into bounded attachment modes', () => {
    expect(
      resolveCanvasAttachmentModesForSend(
        [
          { cmd: 'canvas', value: 'canvas:selection', label: '/canvas: Selected objects' },
          { cmd: 'canvas', value: 'canvas:selection', label: '/canvas: Selected objects' },
        ],
        'Summarize these',
      ),
    ).toEqual(['selection']);
    expect(resolveCanvasAttachmentModesForSend([], '/canvas summarize the active board')).toEqual([
      'current',
    ]);
    expect(
      resolveCanvasAttachmentModesForSend(
        [{ cmd: 'canvas', value: 'reference:canvas', label: '/canvas: Active Canvas' }],
        '',
      ),
    ).toEqual(['current']);
    expect(resolveCanvasAttachmentModesForSend([], 'Discuss /canvas later')).toEqual([]);
    expect(
      resolveCanvasAttachmentModesForSend(
        [{ cmd: 'canvas', value: 'canvas:frame', label: '/canvas: Selected frame' }],
        '',
      ),
    ).toEqual(['frame']);
  });

  it('turns a validated Canvas PNG snapshot into a vision attachment without retaining bytes', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const image = canvasSnapshotToImageAttachment({
      id: 'snapshot-1',
      canvasId: 'canvas-1',
      projectId: 'project-1',
      capturedAt: 30,
      filename: 'canvas-snapshot.png',
      mimeType: 'image/png',
      bytes,
    });

    expect(image).toEqual({
      id: 'canvas_snapshot_snapshot-1',
      name: 'canvas-snapshot.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
      size: 8,
    });
    bytes[0] = 0;
    expect(image.data).toBe('iVBORw0KGgo=');
  });
});

describe('composer active Canvas source collection', () => {
  it('adds the exact active account/project Canvas sources and rejects hidden-route context', () => {
    clearActiveCanvasAiContextForTests();
    const document = createCanvasDocument({
      id: 'canvas-1',
      projectId: 'project-1',
      ownerId: 'account-1',
      title: 'Architecture canvas',
      now: 10,
    });
    publishActiveCanvasAiContextProvider({
      accountId: 'account-1',
      ownerId: 'account-1',
      projectId: 'project-1',
      canvasId: 'canvas-1',
      getContext: () => compileCanvasAiContext({ document }),
    });

    expect(mergeActiveCanvasSourcesForPromptForge([], 'account-1', 'project-1', false)).toEqual([]);
    expect(mergeActiveCanvasSourcesForPromptForge([], 'account-other', 'project-1', true)).toEqual(
      [],
    );
    expect(
      mergeActiveCanvasSourcesForPromptForge([], 'account-1', 'project-1', true).map(
        ({ id, label, reference }) => ({ id, label, reference }),
      ),
    ).toEqual([
      {
        id: 'canvas:canvas-1',
        label: 'Architecture canvas',
        reference: 'canvas:canvas-1',
      },
    ]);
    clearActiveCanvasAiContextForTests();
  });
});
