import { describe, expect, it, vi } from 'vitest';
import {
  buildAllAboutMeRevisionPrompt,
  buildAllAboutMeRetakeUpdatePrompt,
  generateAllAboutMeMarkdown,
  reviseAllAboutMeMarkdown,
} from './ai';
import type { AllAboutMeAnswers } from './profile';

const answers: AllAboutMeAnswers = {
  communicationStyle: 'Direct and high energy.',
  toneExamples: 'Make this production ready.',
  interests: 'AI agents, polished apps, music.',
  strongReactions: 'Placeholders and crashes.',
  preferences: ['short-direct', 'launch-ready'],
  dislikedPatterns: ['generic replies'],
  responseStyle: 'Confident and concise.',
  personalNotes: 'Likes rapid progress with proof.',
};

describe('AllAboutMe AI helpers', () => {
  it('uses model markdown when generation returns a valid AllAboutMe document', async () => {
    const complete = vi.fn(async () => '# AllAboutMe.md\n\n## Voice\n\nDirect.');

    const markdown = await generateAllAboutMeMarkdown(answers, complete);

    expect(complete).toHaveBeenCalledOnce();
    expect(markdown).toContain('## Voice');
  });

  it('falls back to deterministic markdown when the model returns unusable content', async () => {
    const complete = vi.fn(async () => 'not markdown');

    const markdown = await generateAllAboutMeMarkdown(answers, complete);

    expect(markdown).toContain('# AllAboutMe.md');
    expect(markdown).toContain('Direct and high energy');
  });

  it('propagates runtime failures so the UI can show an actionable error', async () => {
    const complete = vi.fn(async () => {
      throw new Error('Local model runtime is unavailable. Start Ollama.');
    });

    await expect(generateAllAboutMeMarkdown(answers, complete)).rejects.toThrow(/Start Ollama/i);
  });

  it('builds revision prompts that preserve the existing profile', () => {
    const prompt = buildAllAboutMeRevisionPrompt({
      existingMarkdown: '# AllAboutMe.md\n\nStable identity.',
      recentUserMessages: ['BRO make it shorter', 'No placeholders ever'],
    });

    expect(prompt).toContain('Preserve the existing profile');
    expect(prompt).toContain('Stable identity');
    expect(prompt).toContain('BRO make it shorter');
  });

  it('builds retake update prompts with old profile and new test answers', () => {
    const prompt = buildAllAboutMeRetakeUpdatePrompt({
      existingMarkdown: '# AllAboutMe.md\n\n## Stable\n\nKeep this.',
      answers,
    });

    expect(prompt).toContain('update an existing `AllAboutMe.md` after a retake');
    expect(prompt).toContain('Keep this.');
    expect(prompt).toContain('Quiz answers from the retake');
    expect(prompt).toContain('Direct and high energy.');
  });

  it('keeps the old profile when a chat-learning revision is malformed', async () => {
    const complete = vi.fn(async () => 'short note only');
    const existing = '# AllAboutMe.md\n\nStable identity.';

    const markdown = await reviseAllAboutMeMarkdown(
      { existingMarkdown: existing, recentUserMessages: ['short answers please'] },
      complete,
    );

    expect(markdown).toBe(existing);
  });
});
