import { describe, expect, it } from 'vitest';
import {
  ALL_ABOUT_ME_CONTEXT_LIMIT,
  ALL_ABOUT_ME_FILE_LOCATION,
  ALL_ABOUT_ME_TEST_QUESTIONS,
  ALL_ABOUT_ME_UPDATE_INTERVAL,
  buildAllAboutMeContextBlock,
  buildAllAboutMeMarkdown,
  shouldUpdateAllAboutMe,
  type AllAboutMeAnswers,
} from './profile';

const answers: AllAboutMeAnswers = {
  communicationStyle: 'Fast, direct, excited, lots of urgency when something matters.',
  toneExamples: 'I say things like "bro please make it production ready" and I like confident short answers.',
  interests: 'AI agents, app design, YouTube, music, game development, polished UI.',
  strongReactions: 'I hate placeholders, fake wiring, crashes, and long generic AI replies.',
  preferences: ['short-direct', 'high-energy', 'production-focused'],
  dislikedPatterns: ['walls-of-text', 'placeholder-copy'],
  responseStyle: 'Sound like a focused teammate who gets straight to the fix.',
  personalNotes: 'I care a lot about launch readiness and keeping the app stable.',
};

describe('AllAboutMe profile core', () => {
  it('defines the final 60-question test with mostly written responses', () => {
    expect(ALL_ABOUT_ME_TEST_QUESTIONS).toHaveLength(60);
    expect(ALL_ABOUT_ME_TEST_QUESTIONS[0]?.prompt).toBe('What name or nickname should Jarvis call you?');
    expect(ALL_ABOUT_ME_TEST_QUESTIONS[59]?.prompt).toBe('Imagine Jarvis became perfect for you. What would it always do without you asking?');
    expect(ALL_ABOUT_ME_TEST_QUESTIONS.filter((question) => question.kind === 'written').length).toBeGreaterThan(30);
    expect(ALL_ABOUT_ME_TEST_QUESTIONS.every((question) => question.prompt.trim().length > 0)).toBe(true);
  });

  it('exposes a stable user-facing AllAboutMe.md location', () => {
    expect(ALL_ABOUT_ME_FILE_LOCATION).toContain('AllAboutMe.md');
  });

  it('builds a structured AllAboutMe.md document from quiz answers', () => {
    const markdown = buildAllAboutMeMarkdown(answers);

    expect(markdown).toContain('# AllAboutMe.md');
    expect(markdown).toContain('## Communication Style');
    expect(markdown).toContain('Fast, direct, excited');
    expect(markdown).toContain('## Strong Reactions');
    expect(markdown).toContain('placeholders');
    expect(markdown).toContain('- short-direct');
    expect(markdown).toContain('Generated from the in-app All About Me quiz.');
  });

  it('wraps the profile in a bounded Jarvis-safe context block', () => {
    const longMarkdown = `# AllAboutMe.md\n${'voice '.repeat(3000)}`;
    const block = buildAllAboutMeContextBlock(longMarkdown);

    expect(block).toContain('durable user-personality profile');
    expect(block).toContain('--- all_about_me_profile ---');
    expect(block.length).toBeLessThanOrEqual(ALL_ABOUT_ME_CONTEXT_LIMIT + 500);
    expect(block).toContain('truncated by VibeSpace');
  });

  it('updates after every 20 new user messages only', () => {
    expect(ALL_ABOUT_ME_UPDATE_INTERVAL).toBe(20);
    expect(shouldUpdateAllAboutMe({ totalUserMessages: 19, lastUpdatedAtMessageCount: 0 })).toBe(false);
    expect(shouldUpdateAllAboutMe({ totalUserMessages: 20, lastUpdatedAtMessageCount: 0 })).toBe(true);
    expect(shouldUpdateAllAboutMe({ totalUserMessages: 39, lastUpdatedAtMessageCount: 20 })).toBe(false);
    expect(shouldUpdateAllAboutMe({ totalUserMessages: 40, lastUpdatedAtMessageCount: 20 })).toBe(true);
  });
});
