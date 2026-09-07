import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Composer selected speech engine contract', () => {
  it('routes only to the saved engine and has no silent system, Groq, or OS-dictation fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');

    const selected = readFileSync(resolve(process.cwd(), 'src/features/global-dictation/dictationSession.ts'), 'utf8');
    const controller = readFileSync(resolve(process.cwd(), 'src/features/composer-stt/composerDictationController.ts'), 'utf8');
    expect(source).toContain('createComposerDictationController');
    expect(source).toContain('Accept dictation');
    expect(controller).toContain('await createSelectedSttSession(');
    expect(selected).toContain("if (provider === 'faster-whisper') {");
    expect(selected).toContain("if (provider === 'deepgram') {");
    expect(selected).toContain('createWebSpeechSession(scopedEvents, assertCurrent)');
    expect(source).not.toContain('trySystemSttFallbacks');
    expect(source).not.toContain('triggerWindowsNativeDictation');
    expect(source).not.toContain('startGroqStt');
    expect(source).not.toContain('transcribeGroq');
  });
});
