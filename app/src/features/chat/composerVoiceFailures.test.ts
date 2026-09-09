import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatComposerVoiceFailure } from './composerVoiceFailures';

describe('Composer voice failure narration', () => {
  it.each([
    {
      kind: 'system_startup' as const,
      expected:
        'The action failed, sir. Action: System speech recognition startup. Cause: The system speech-recognition path could not start. Check microphone access, then try again.',
    },
    {
      kind: 'local_capture' as const,
      expected:
        'The action failed, sir. Action: Local dictation microphone. Cause: The local dictation recorder could not access a working microphone. Falling back to system dictation.',
    },
    {
      kind: 'local_transcription' as const,
      expected:
        'The action failed, sir. Action: Local speech transcription. Cause: The local model could not transcribe the captured audio. Falling back to system dictation.',
    },
  ])('formats $kind with exact actionable shared narration', ({ kind, expected }) => {
    expect(formatComposerVoiceFailure(kind)).toBe(expected);
  });

  it('routes Composer dictation through the controller with safe failure narration', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');
    const controller = readFileSync(path.join(process.cwd(), 'src/features/composer-stt/composerDictationController.ts'), 'utf8');
    expect(source).toContain('createComposerDictationController({');
    expect(source).toContain('useSyncExternalStore(sttController.subscribe, sttController.getSnapshot)');
    expect(controller).toContain('fail(formatGlobalDictationSessionFailure(message))');
    expect(controller).not.toMatch(/\b(?:err|error)\.message\b/u);
    expect(controller).toContain('Could not start the selected speech engine.');
    expect(controller).toContain('The selected speech engine could not finish transcription.');
  });
});
