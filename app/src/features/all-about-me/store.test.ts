import { beforeEach, describe, expect, it } from 'vitest';
import { useAllAboutMeStore } from './store';
import type { AllAboutMeAnswers } from './profile';

const answers: AllAboutMeAnswers = {
  communicationStyle: 'Short, excited, direct.',
  toneExamples: 'Please make it production ready.',
  interests: 'AI agents and music.',
  strongReactions: 'Crashes and placeholders.',
  preferences: ['short-direct'],
  dislikedPatterns: ['generic replies'],
  responseStyle: 'Confident teammate.',
  personalNotes: 'Launch readiness matters.',
};

describe('AllAboutMe store', () => {
  beforeEach(() => {
    localStorage.clear();
    useAllAboutMeStore.setState(useAllAboutMeStore.getInitialState(), true);
  });

  it('saves quiz answers with generated markdown', () => {
    useAllAboutMeStore.getState().saveQuizProfile(answers, '# AllAboutMe.md\nProfile');

    const state = useAllAboutMeStore.getState();
    expect(state.quizAnswers?.communicationStyle).toBe('Short, excited, direct.');
    expect(state.markdown).toContain('# AllAboutMe.md');
    expect(state.source).toBe('quiz');
    expect(state.learningEnabled).toBe(true);
  });

  it('queues an automatic private profile refresh after twenty user messages', () => {
    const store = useAllAboutMeStore.getState();
    store.saveQuizProfile(answers, '# AllAboutMe.md\nProfile');
    for (let i = 0; i < 19; i += 1) store.recordUserMessage();

    expect(useAllAboutMeStore.getState().totalUserMessages).toBe(19);
    expect(useAllAboutMeStore.getState().needsLearningUpdate()).toBe(false);
    store.recordUserMessage();
    expect(useAllAboutMeStore.getState().needsLearningUpdate()).toBe(true);
  });

  it('records the completed cadence after a curated revision', () => {
    const store = useAllAboutMeStore.getState();
    store.saveQuizProfile(answers, '# AllAboutMe.md\nOld profile');
    for (let i = 0; i < 20; i += 1) store.recordUserMessage();

    store.applyLearningRevision('# AllAboutMe.md\nOld profile\n\nNew repeated pattern.');

    const state = useAllAboutMeStore.getState();
    expect(state.source).toBe('chat-learning');
    expect(state.markdown).toContain('New repeated pattern');
    expect(state.lastUpdatedAtMessageCount).toBe(20);
    expect(state.needsLearningUpdate()).toBe(false);
  });

  it('autosaves unfinished test progress for later', () => {
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: 'google:gemini-2.5-flash',
      mode: 'create',
      questionValues: { displayName: 'Viper', onlinePersonality: 'Bold' },
    });

    const draft = useAllAboutMeStore.getState().testDraft;
    expect(draft?.selectedModelId).toBe('google:gemini-2.5-flash');
    expect(draft?.questionValues.displayName).toBe('Viper');
    expect(draft?.mode).toBe('create');
    expect(typeof draft?.updatedAt).toBe('number');
  });

  it('clears draft progress after a completed profile save', () => {
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: 'google:gemini-2.5-flash',
      mode: 'update',
      questionValues: { displayName: 'Viper' },
    });

    useAllAboutMeStore.getState().saveQuizProfile(answers, '# AllAboutMe.md\nProfile');

    expect(useAllAboutMeStore.getState().testDraft).toBeNull();
  });

  it('requires exact delete confirmation before wiping the profile and draft', () => {
    const store = useAllAboutMeStore.getState();
    store.saveQuizProfile(answers, '# AllAboutMe.md\nProfile');
    store.saveTestDraft({ selectedModelId: 'google:gemini-2.5-flash', mode: 'update', questionValues: { displayName: 'Viper' } });

    expect(store.deleteProfile('Delete')).toBe(false);
    expect(useAllAboutMeStore.getState().markdown).toContain('Profile');

    expect(useAllAboutMeStore.getState().deleteProfile('delete')).toBe(true);
    expect(useAllAboutMeStore.getState().markdown).toBe('');
    expect(useAllAboutMeStore.getState().testDraft).toBeNull();
  });

  it('can disable chat learning without deleting the profile', () => {
    useAllAboutMeStore.getState().saveQuizProfile(answers, '# AllAboutMe.md\nProfile');
    useAllAboutMeStore.getState().setLearningEnabled(false);

    expect(useAllAboutMeStore.getState().learningEnabled).toBe(false);
    expect(useAllAboutMeStore.getState().markdown).toContain('Profile');
  });

  it('does not persist credential-shaped lines in the stable profile', () => {
    useAllAboutMeStore.getState().setMarkdown([
      '# AllAboutMe.md',
      'Likes concise answers.',
      'apiKey=do-not-store-this',
      'My password is hunter2',
      'Still prefers official sources.',
    ].join('\n'));

    expect(useAllAboutMeStore.getState().markdown).toContain('Likes concise answers.');
    expect(useAllAboutMeStore.getState().markdown).toContain('Still prefers official sources.');
    expect(useAllAboutMeStore.getState().markdown).not.toContain('do-not-store-this');
    expect(useAllAboutMeStore.getState().markdown).not.toContain('hunter2');
  });

  it('does not duplicate the private profile or account scope into localStorage', () => {
    useAllAboutMeStore.getState().setAccountScope('private-account@example.com');
    useAllAboutMeStore.getState().setMarkdown('# All About Me\n\nPrivate preference');

    expect(localStorage.getItem('jarvis-all-about-me')).toBeNull();
  });
});
