import { describe, expect, it } from 'vitest';
import { MARKDOWN_DOCUMENT_OPTIONS, buildMarkdownCreationInstruction } from './markdownCommand';

describe('markdownCommand', () => {
  it('offers every supported document kind in the requested order', () => {
    expect(MARKDOWN_DOCUMENT_OPTIONS.map(({ id }) => id)).toEqual([
      'goal',
      'agent',
      'skill',
      'prompt',
      'design',
      'test',
      'policy',
      'context',
      'custom',
    ]);
  });

  it('compiles a goal brief into a bounded create-and-attach instruction', () => {
    const instruction = buildMarkdownCreationInstruction({
      kind: 'goal',
      brief: 'Ship the local model reliability milestone.',
      projectRoot: 'C:\\Projects\\VibeSpace',
      fullyLocal: false,
    });

    expect(instruction).toContain('C:\\Projects\\VibeSpace\\docs\\generated');
    expect(instruction).toContain('"actionId":"files.create"');
    expect(instruction).toContain('"attachToChat":true');
    expect(instruction).toContain('Acceptance criteria');
    expect(instruction).toContain('Ship the local model reliability milestone.');
    expect(instruction).toContain('Never invent');
  });

  it('forbids public research in fully local chat', () => {
    const instruction = buildMarkdownCreationInstruction({
      kind: 'context',
      brief: 'Document the current repository context.',
      projectRoot: null,
      fullyLocal: true,
    });

    expect(instruction).toContain('Jarvis Projects\\docs\\generated');
    expect(instruction).toContain('Do not use public online sources');
    expect(instruction).not.toContain('Public online research is allowed');
  });
});
