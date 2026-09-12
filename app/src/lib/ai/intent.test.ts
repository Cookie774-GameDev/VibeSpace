import { describe, expect, it } from 'vitest';
import {
  classifyJarvisIntent,
  isLightweightChatTurn,
  shouldAutoRetrieveProjectKnowledge,
} from './intent';

describe('classifyJarvisIntent', () => {
  it('keeps greetings and informational steps out of visible implementation plans', () => {
    expect(classifyJarvisIntent({ text: 'Hi' })).toMatchObject({
      kind: 'greeting', needsVisiblePlan: false, needsImplementationApproval: false,
    });
    expect(classifyJarvisIntent({ text: 'Hi there, GPT-5.3 Spark' }).kind).toBe('greeting');
    expect(classifyJarvisIntent({ text: 'How do I make coffee step by step?' })).toMatchObject({
      kind: 'informational', needsVisiblePlan: false, needsImplementationApproval: false,
    });
  });

  it('honors an explicit request for questions before implementation', () => {
    expect(classifyJarvisIntent({ text: 'Build a game, but ask me three questions first.' })).toMatchObject({
      kind: 'clarification-needed', needsQuestions: true,
    });
  });

  it('distinguishes file creation, editing, commands, and project builds', () => {
    expect(classifyJarvisIntent({ text: 'Create a new file named dogs.' }).kind).toBe('file-create');
    expect(classifyJarvisIntent({ text: 'Update the existing ROADMAP.md file.' }).kind).toBe('file-edit');
    expect(classifyJarvisIntent({ text: 'Run the game in the terminal.' }).kind).toBe('command-run');
    expect(classifyJarvisIntent({ text: 'Build an HTML puzzle game.' })).toMatchObject({
      kind: 'project-build', needsVisiblePlan: true, needsImplementationApproval: true,
    });
  });

  it('does not let structured output bypass destructive safeguards', () => {
    expect(classifyJarvisIntent({ text: 'Deploy this.', structuredKind: 'informational' })).toMatchObject({
      kind: 'destructive', needsQuestions: true, needsImplementationApproval: true,
    });
  });
});

describe('shouldAutoRetrieveProjectKnowledge', () => {
  it('skips automatic map/repository scans for short conversational turns', () => {
    const greeting = classifyJarvisIntent({ text: 'Hi' });
    const tiny = classifyJarvisIntent({
      text: 'Reply with exactly: HI FROM QWEN LATENCY PROBE',
    });
    const coffee = classifyJarvisIntent({ text: 'How do I make coffee step by step?' });
    expect(shouldAutoRetrieveProjectKnowledge({ text: 'Hi', intent: greeting })).toBe(false);
    expect(isLightweightChatTurn(greeting, 'Hi')).toBe(true);
    expect(
      isLightweightChatTurn(
        classifyJarvisIntent({ text: 'Hi there, GPT-5.3 Spark' }),
        'Hi there, GPT-5.3 Spark',
      ),
    ).toBe(true);
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'Reply with exactly: HI FROM QWEN LATENCY PROBE',
        intent: tiny,
      }),
    ).toBe(false);
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'How do I make coffee step by step?',
        intent: coffee,
      }),
    ).toBe(false);
    const here = classifyJarvisIntent({ text: 'what changed here?' });
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'what changed here?',
        intent: here,
      }),
    ).toBe(true);
  });

  it('keeps retrieval for file/corpus questions, mutations, and explicit attachments', () => {
    const files = classifyJarvisIntent({
      text: 'hey can u read these files and answer these five questions for me',
    });
    const create = classifyJarvisIntent({ text: 'Create a new file named dogs.' });
    const greeting = classifyJarvisIntent({ text: 'Hi' });
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'hey can u read these files and answer these five questions for me',
        intent: files,
      }),
    ).toBe(true);
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'Create a new file named dogs.',
        intent: create,
      }),
    ).toBe(true);
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: 'Hi',
        intent: greeting,
        hasExplicitAttachments: true,
      }),
    ).toBe(true);
    const diskReadText =
      'Read these 10 existing files from disk using only registered files.read actions.\nC:\\Users\\viper\\Downloads\\proof.txt\nC:\\Users\\viper\\Downloads\\other.txt';
    const diskRead = classifyJarvisIntent({ text: diskReadText });
    expect(
      shouldAutoRetrieveProjectKnowledge({
        text: diskReadText,
        intent: diskRead,
        hasExplicitAttachments: true,
      }),
    ).toBe(false);
  });
});
