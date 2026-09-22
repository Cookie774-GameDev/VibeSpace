import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLocalCommandPersistedParts } from './Composer';

const source = readFileSync(resolve(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');

describe('Composer local command bridge integration contract', () => {
  it('runs the shared bridge after queue decisions and before model preparation', () => {
    const queue = source.indexOf('!caoDecision?.control');
    const bridge = source.indexOf('sharedLocalCommandPreModelBridge.process');
    const promptForge = source.indexOf('// Shared Prompt Upgrade Engine:');
    const modelValidation = source.indexOf('const sendCheck = validateSendModelAccess(');

    expect(queue).toBeGreaterThan(0);
    expect(bridge).toBeGreaterThan(queue);
    expect(promptForge).toBeGreaterThan(bridge);
    expect(modelValidation).toBeGreaterThan(promptForge);
    expect(source).toContain('localCommandInteractionId: queued.id');
    expect(source).toContain('localCommandInteractionId: message.id');
    expect(source).toContain("'Local action unavailable'");
    expect(source).not.toContain('localCommandResult = null');
  });

  it('keeps authority capture synchronous and forwards model-only hidden context', () => {
    const authority = source.indexOf(
      'const toolGatewayAuthority = captureToolGatewayAuthorityClaim();',
    );
    const bridge = source.indexOf('sharedLocalCommandPreModelBridge.process');
    expect(authority).toBeGreaterThan(0);
    expect(bridge).toBeGreaterThan(authority);
    expect(source).toContain('modelText: sendText');
    expect(source).toContain('localCommandContext: localCommandResult.localActionContext');
    expect(source).toContain('text: originalRawSendText');
  });

  it('persists original command text and attachments without hidden receipt text', () => {
    const parts = buildLocalCommandPersistedParts({
      text: 'Draft a game and open a Claude terminal',
      images: [
        {
          id: 'image-1',
          name: 'reference.png',
          mimeType: 'image/png',
          data: 'AAAA',
          size: 4,
        },
      ],
      files: ['C:\\workspace\\brief.txt'],
      terminals: [],
      contexts: [],
    });

    expect(parts[0]).toEqual({ kind: 'text', text: 'Draft a game and open a Claude terminal' });
    expect(parts).toContainEqual({
      kind: 'image',
      url: 'data:image/png;base64,AAAA',
      alt: 'reference.png',
    });
    expect(parts).toContainEqual({
      kind: 'file_ref',
      ref: { kind: 'file', id: 'C:\\workspace\\brief.txt' },
    });
    expect(JSON.stringify(parts)).not.toContain('local action receipts');
  });

  it('uses the ordinary context reference part for note attachments', () => {
    const parts = buildLocalCommandPersistedParts({
      text: '  open settings  ',
      images: [],
      files: [],
      terminals: [],
      contexts: [
        {
          projectId: 'project-a',
          rootDir: 'notes://scope-hash',
          generatedAt: 1,
          nodeId: 'note:fixture-a',
          mapId: 'notes:scope-hash:fixture-a',
          title: 'Fixture note',
          kind: 'note',
          summary: 'Fixture note',
          attachmentLevel: 'note',
          source: { type: 'linked_vibespace_content', label: 'Notes / fixture-a' },
          freshness: 'current',
          itemCount: 1,
        },
      ],
    });

    expect(parts).toContainEqual({
      kind: 'file_ref',
      ref: {
        kind: 'memory',
        id: 'context:p9:project-a26:notes:scope-hash:fixture-a14:note:fixture-anote',
        excerpt: 'Context: Fixture note',
      },
    });
  });

  it('persists successful whole-message instant commands against the submitted chat', () => {
    const instantBranch = source.indexOf('if (isComposerInstantCommandSource(trimmed))');
    const instantSubmit = source.indexOf('submitComposerInstantCommand({', instantBranch);
    const instantPersist = source.indexOf('await messageRepo.create({', instantSubmit);
    const instantPersistEnd = source.indexOf(
      'if (!instantCommandResult.handled || !instantCommandResult.ok)',
      instantPersist,
    );
    const instantPersistBlock = source.slice(instantPersist, instantPersistEnd);

    expect(instantBranch).toBeGreaterThan(0);
    expect(instantSubmit).toBeGreaterThan(instantBranch);
    expect(instantPersist).toBeGreaterThan(instantSubmit);
    expect(source.slice(instantSubmit, instantPersist)).toContain(
      'instantCommandResult.handled && instantCommandResult.ok',
    );
    expect(instantPersistEnd).toBeGreaterThan(instantPersist);
    expect(source.slice(instantBranch, instantSubmit)).toContain(
      'const instantPersistedChatId = chatId as ChatId',
    );
    expect(instantPersistBlock).toContain('chat_id: instantPersistedChatId');
    expect(instantPersistBlock).toContain('buildLocalCommandPersistedParts({');
    expect(instantPersistBlock).toContain('text: instantPersistedText');
    expect(instantPersistBlock).toContain('images: instantPersistedAttachments.images');
    expect(instantPersistBlock).toContain('files: instantPersistedAttachments.files');
    expect(source.slice(instantBranch, instantSubmit)).toContain('notes: [...attachedNotes]');
    expect(instantPersistBlock).toContain('contexts: instantPersistedContexts');
    expect(source.indexOf('setAttachedFiles([])', instantPersist) > instantPersist).toBe(true);
  });
});
