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

  it('keeps an explicit plan-only request visible without authorizing implementation', () => {
    expect(
      classifyJarvisIntent({
        text: 'Create a concise three-step plan for a welcome banner. Do not implement anything.',
      }),
    ).toMatchObject({
      kind: 'plan-only',
      needsVisiblePlan: true,
      needsImplementationApproval: false,
      canProceedReadOnly: true,
    });
  });

  it('does not let structured output bypass destructive safeguards', () => {
    expect(classifyJarvisIntent({ text: 'Deploy this.', structuredKind: 'informational' })).toMatchObject({
      kind: 'destructive', needsQuestions: true, needsImplementationApproval: true,
    });
  });

  it.each([
    'Create a plan and then implement the app.',
    'Write a plan.md file for this project.',
  ])('does not turn a requested mutation into plan-only: %s', text => {
    expect(classifyJarvisIntent({ text }).needsImplementationApproval).toBe(true);
  });

  it.each([
    'Plan a tiny offline recipe organizer as a browser app using local storage. Give three implementation steps and one validation step. All requirements are supplied; do not ask questions. Do not edit files or run commands. Present the plan for approval.',
    'Redo this plan with this instruction: add keyboard navigation, without editing files.',
  ])('keeps explicit planning read-only despite implementation terminology: %s', text => {
    expect(classifyJarvisIntent({ text })).toMatchObject({kind: 'plan-only', needsVisiblePlan: true, needsImplementationApproval: false});
  });
});

describe('shouldAutoRetrieveProjectKnowledge', () => {
  it.each([
    'Build the CSV tool. Do not use Context Maps.',
    'Write the two files. No Context Maps, subagents, or other paths.',
    'Do not inspect sibling output folders, unrelated projects, or Context Maps.',
    'Run the tests without using RLM.',
  ])('honors explicit automatic Context retrieval opt-out: %s', text => {
    expect(shouldAutoRetrieveProjectKnowledge({
      text, intent: classifyJarvisIntent({ text }), hasExplicitAttachments: true,
    })).toBe(false);
  });

  it.each([
    'Use Context Maps to find the package version.',
    'Do not edit files. Use Context Maps to find the package version.',
    'Use RLM to inspect the corpus without editing it.',
  ])('preserves requested retrieval: %s', text => {
    expect(shouldAutoRetrieveProjectKnowledge({
      text, intent: classifyJarvisIntent({ text }), hasExplicitAttachments: true,
    })).toBe(true);
  });

  it.each([
    'Review the submitted answers to your earlier audit questions and tell me which color and detail level I chose. One sentence, without tools or subagents.',
    'Answer from our conversation. Do not use tools to search the project files.',
    'Explain this source excerpt without using any tools.',
  ])('honors an explicit no-tool request before automatic retrieval: %s', text => {
    expect(shouldAutoRetrieveProjectKnowledge({
      text, intent: classifyJarvisIntent({ text }), hasExplicitAttachments: true,
    })).toBe(false);
  });

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
