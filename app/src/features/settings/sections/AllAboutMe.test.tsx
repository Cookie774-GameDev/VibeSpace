import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { ALL_ABOUT_ME_TEST_QUESTIONS } from '@/features/all-about-me/profile';
import { AllAboutMe } from './AllAboutMe';

const models = [
  {
    id: 'google:gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google' as const,
    model: 'gemini-2.5-flash',
  },
];

function filledAnswers(
  value = 'Short, direct, high-energy and production ready.',
): Record<string, string> {
  return Object.fromEntries(ALL_ABOUT_ME_TEST_QUESTIONS.map((question) => [question.id, value]));
}

describe('AllAboutMe settings section', () => {
  beforeEach(() => {
    useAllAboutMeStore.setState(useAllAboutMeStore.getInitialState(), true);
  });

  it('generates AllAboutMe.md from the grade step after answers are ready', async () => {
    const completePrompt = vi.fn(
      async () => '# AllAboutMe.md\n\n## Communication Style\n\nShort and intense.',
    );
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: 'google:gemini-2.5-flash',
      mode: 'create',
      questionValues: filledAnswers(),
    });

    render(<AllAboutMe completePrompt={completePrompt} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Resume saved test/i }));

    // Full draft opens grade step — model picker only here, not mid-quiz.
    expect(screen.getByRole('progressbar', { name: /All About Me test progress/i })).toBeTruthy();
    expect(screen.getByText('Generation model')).toBeTruthy();
    expect(screen.getByLabelText(/AI model for grading/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/AI model for grading/i), {
      target: { value: 'google:gemini-2.5-flash' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate AllAboutMe.md/i }));

    await waitFor(() => expect(completePrompt).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Short and intense/i)).toBeTruthy();
    expect(useAllAboutMeStore.getState().markdown).toContain('# AllAboutMe.md');
    expect(screen.getByText(/VibeSpace Profile Vault\/AllAboutMe.md/i)).toBeTruthy();
  });

  it('does not show the grading model picker on the first question', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));

    expect(screen.getByRole('dialog', { name: /All About Me Test/i })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /All About Me test progress/i })).toBeTruthy();
    expect(screen.getByTestId('all-about-me-question-progress').textContent).toMatch(/0\/60/);
    expect(screen.getByTestId('all-about-me-question-map')).toBeTruthy();
    expect(screen.getByTestId('all-about-me-q-chip-1')).toBeTruthy();
    expect(screen.getByTestId('all-about-me-q-chip-60')).toBeTruthy();
    expect(screen.queryByLabelText(/AI model for grading/i)).toBeNull();
    expect(screen.queryByText(/Grade with which model/i)).toBeNull();
  });

  it('keeps the quick test stage centered and width-constrained beside the 60-question strip', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));

    const dialog = screen.getByRole('dialog', { name: /All About Me Test/i });
    const stage = screen.getByTestId('all-about-me-question-stage');
    const map = screen.getByTestId('all-about-me-question-map');

    expect(dialog.className).toContain('grid-cols-[minmax(0,1fr)]');
    expect(dialog.className).toContain('max-w-none');
    expect(stage.className).toContain('min-w-0');
    expect(stage.className).toContain('w-full');
    expect(map.className).toContain('min-w-0');
    expect(screen.getByRole('button', { name: /Skip question/i })).toBeTruthy();
  });

  it('allows submit and generate with zero answers', async () => {
    const completePrompt = vi.fn(async () => '# AllAboutMe.md\n\n## Notes\n\nEmpty run.');
    render(<AllAboutMe completePrompt={completePrompt} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Submit$/i }));
    expect(screen.getByLabelText(/AI model for grading/i)).toBeTruthy();
    expect(screen.getByText(/none required/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Generate AllAboutMe.md/i }));
    await waitFor(() => expect(completePrompt).toHaveBeenCalledOnce());
    expect(useAllAboutMeStore.getState().markdown).toContain('# AllAboutMe.md');
  });

  it('jumps to a question when its number chip is clicked', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));

    fireEvent.click(screen.getByTestId('all-about-me-q-chip-12'));
    expect(screen.getByTestId('all-about-me-q-chip-12').getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('all-about-me-q-chip-1').getAttribute('data-current')).toBe('false');
    // Q12 prompt is on screen (choice or written)
    expect(screen.getByText(ALL_ABOUT_ME_TEST_QUESTIONS[11]!.prompt)).toBeTruthy();
  });

  it('blocks the test when no real AI model is available', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={[]} />);

    expect(screen.getByRole('button', { name: /Take the test/i })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Connect a real AI model/i)).toBeTruthy();
  });

  it('replaces a stale saved grading model when opening the grade step', async () => {
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: 'google:legacy-manual-model',
      mode: 'create',
      questionValues: filledAnswers(),
    });
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Resume saved test/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/AI model for grading/i)).toHaveProperty(
        'value',
        'google:gemini-2.5-flash',
      ),
    );
    expect(screen.queryByRole('option', { name: /legacy-manual-model/i })).toBeNull();
  });

  it('separates the stable profile from automatic learning memory', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={[]} />);

    expect(screen.getByText(/Intentional profile/i)).toBeTruthy();
    expect(
      screen.getByText(
        /changes this document only when you complete the profile flow or make an explicit edit/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Automatic interaction preferences are stored separately in learning\.md/i),
    ).toBeTruthy();
    expect(screen.queryByText(/After every 10 user messages/i)).toBeNull();
  });

  it('autosaves progress when the popup is paused and resumes later', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));
    fireEvent.change(screen.getByLabelText(/What name or nickname/i), {
      target: { value: 'Viper' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Pause$/i }));

    expect(useAllAboutMeStore.getState().testDraft?.questionValues.displayName).toBe('Viper');
    expect(screen.queryByRole('dialog', { name: /All About Me Test/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Resume saved test/i }));
    expect(screen.getByTestId('all-about-me-q-chip-2').getAttribute('data-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByLabelText(/What name or nickname/i)).toHaveProperty('value', 'Viper');
  });

  it('advances with Ctrl+Enter and updates the Answered indicator live', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));

    expect(screen.getByTestId('all-about-me-q-chip-1').getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('all-about-me-current-answered').getAttribute('data-answered')).toBe(
      'false',
    );
    expect(screen.getByTestId('all-about-me-current-answered').textContent).toMatch(/Unanswered/i);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Viper' } });
    expect(screen.getByTestId('all-about-me-current-answered').getAttribute('data-answered')).toBe(
      'true',
    );
    expect(screen.getByTestId('all-about-me-current-answered').textContent).toMatch(/Answered/i);
    expect(screen.getByTestId('all-about-me-question-progress').textContent).toMatch(/1\/60/);
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    expect(screen.getByTestId('all-about-me-q-chip-2').getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('all-about-me-q-chip-1').getAttribute('data-answered')).toBe('true');
  });

  it('surfaces generation failures without silently saving a template profile', async () => {
    const completePrompt = vi.fn(async () => {
      throw new Error(
        'Local model runtime is unavailable. Start Ollama, confirm the model is installed under Settings → Local Models, then try Generate again.',
      );
    });
    useAllAboutMeStore.getState().saveTestDraft({
      selectedModelId: 'google:gemini-2.5-flash',
      mode: 'create',
      questionValues: filledAnswers(),
    });
    render(<AllAboutMe completePrompt={completePrompt} modelOptions={models} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume saved test/i }));
    fireEvent.click(screen.getByRole('button', { name: /Generate AllAboutMe.md/i }));

    await waitFor(() => expect(completePrompt).toHaveBeenCalledOnce());
    expect(useAllAboutMeStore.getState().markdown).toBe('');
    expect(screen.getByRole('dialog', { name: /All About Me Test/i })).toBeTruthy();
  });

  it('saves progress immediately on each answer and when the popup is closed (X)', () => {
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));
    fireEvent.change(screen.getByLabelText(/What name or nickname/i), {
      target: { value: 'ViperClose' },
    });
    expect(useAllAboutMeStore.getState().testDraft?.questionValues.displayName).toBe('ViperClose');

    fireEvent.click(screen.getByRole('button', { name: /Close and save test/i }));
    expect(screen.queryByRole('dialog', { name: /All About Me Test/i })).toBeNull();
    expect(useAllAboutMeStore.getState().testDraft?.questionValues.displayName).toBe('ViperClose');
  });

  it('keeps answers when the AllAboutMe section unmounts mid-test (Settings closed)', () => {
    const { unmount } = render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Take the test/i }));
    fireEvent.change(screen.getByLabelText(/What name or nickname/i), {
      target: { value: 'UnmountSave' },
    });
    unmount();

    expect(useAllAboutMeStore.getState().testDraft?.questionValues.displayName).toBe('UnmountSave');
  });

  it('opens retake mode as an update and supports destructive delete confirmation', () => {
    useAllAboutMeStore.getState().saveQuizProfile(
      {
        communicationStyle: 'Old style',
        toneExamples: '',
        interests: '',
        strongReactions: '',
        preferences: [],
        dislikedPatterns: [],
        responseStyle: '',
        personalNotes: '',
      },
      '# AllAboutMe.md\nOld profile',
    );
    render(<AllAboutMe completePrompt={vi.fn()} modelOptions={models} />);

    fireEvent.click(screen.getByRole('button', { name: /Retake to update scores/i }));
    expect(screen.getByRole('dialog', { name: /All About Me Test/i })).toBeTruthy();
    expect(screen.getByTestId('all-about-me-question-map')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Close and save test/i }));
    fireEvent.click(screen.getByRole('button', { name: /Delete AllAboutMe.md/i }));
    fireEvent.change(screen.getByLabelText(/Type delete to confirm/i), {
      target: { value: 'Delete' },
    });
    expect(screen.getByRole('button', { name: /^Delete$/i })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Type delete to confirm/i), {
      target: { value: 'delete' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

    expect(useAllAboutMeStore.getState().markdown).toBe('');
  });
});
