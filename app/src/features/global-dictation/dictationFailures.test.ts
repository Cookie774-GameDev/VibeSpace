import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatGlobalDictationEmptyFailure,
  formatGlobalDictationPasteFailure,
  formatGlobalDictationSessionFailure,
  formatGlobalDictationStartupFailure,
  formatGlobalDictationTranscriptionFailure,
  NO_DICTATION_ENGINE_REASON,
} from './dictationFailures';

describe('global dictation failure narration', () => {
  it('preserves the closed no-engine fix path and suppresses appended details', () => {
    const message = formatGlobalDictationStartupFailure(
      new Error(`${NO_DICTATION_ENGINE_REASON} synthetic provider detail`),
    );

    expect(message).toBe(
      'The action failed, sir. Action: Global dictation availability. ' +
        `Cause: ${NO_DICTATION_ENGINE_REASON}`,
    );
    expect(message).not.toContain('synthetic provider detail');
  });

  it('classifies microphone and unknown startup failures without forwarding raw causes', () => {
    expect(formatGlobalDictationStartupFailure(new Error('Microphone permission denied.'))).toBe(
      'The action failed, sir. Action: Global dictation microphone. ' +
        'Cause: Microphone capture is unavailable or permission was denied. ' +
        'Allow microphone access for VibeSpace, then retry.',
    );
    expect(
      formatGlobalDictationStartupFailure(new Error('synthetic startup implementation detail')),
    ).toBe(
      'The action failed, sir. Action: Global dictation startup. ' +
        'Cause: The dictation session could not start. Check microphone access and the ' +
        'selected speech-to-text engine, then retry.',
    );
  });

  it('preserves shared VoiceService narration and classifies other session failures', () => {
    const shared =
      'The action failed, sir. Action: Microphone permission. ' +
      'Cause: Microphone permission was denied. Allow access in the browser or ' +
      'operating-system settings, then try again.';
    const availability =
      'The action failed, sir. Action: Speech recognition availability. ' +
      'Cause: Built-in speech recognition is not available in this runtime.';
    const startup =
      'The action failed, sir. Action: Speech recognition startup. ' +
      'Cause: The browser could not start recognition. ' +
      'Stop other microphone sessions, then try again.';
    const transcription = formatGlobalDictationTranscriptionFailure('groq');

    expect(formatGlobalDictationSessionFailure(shared)).toBe(shared);
    expect(formatGlobalDictationSessionFailure(`${shared} synthetic provider detail`)).toBe(
      'The action failed, sir. Action: Global dictation recognition. ' +
        'Cause: The selected speech-to-text engine stopped before completing the transcript. ' +
        'Check its connection and configuration, then retry.',
    );
    expect(formatGlobalDictationSessionFailure(availability)).toBe(availability);
    expect(formatGlobalDictationSessionFailure(startup)).toBe(startup);
    expect(formatGlobalDictationSessionFailure(transcription)).toBe(transcription);
    expect(formatGlobalDictationSessionFailure('Deepgram dictation connection failed.')).toBe(
      'The action failed, sir. Action: Deepgram dictation connection. ' +
        'Cause: Deepgram could not connect for live dictation. ' +
        'Check the network and voice-key configuration, then retry.',
    );
    expect(
      formatGlobalDictationSessionFailure(
        'No speech detected for a while — press Retry to keep listening.',
      ),
    ).toBe(
      'The action failed, sir. Action: Global dictation recognition. ' +
        'Cause: No speech was detected. Press Retry and speak again.',
    );
    expect(formatGlobalDictationSessionFailure('synthetic provider websocket detail')).toBe(
      'The action failed, sir. Action: Global dictation recognition. ' +
        'Cause: The selected speech-to-text engine stopped before completing the transcript. ' +
        'Check its connection and configuration, then retry.',
    );
  });

  it('formats batch transcription failure from the closed engine identifier', () => {
    expect(formatGlobalDictationTranscriptionFailure('groq')).toBe(
      'The action failed, sir. Action: Groq Whisper transcription. ' +
        'Cause: Captured audio could not be transcribed. ' +
        'Check the selected engine and connection, then retry.',
    );
  });

  it('formats empty and paste failures with actionable safe diagnostics', () => {
    expect(formatGlobalDictationEmptyFailure()).toBe(
      'The action failed, sir. Action: Global dictation transcription. ' +
        'Cause: No speech was transcribed. Press Retry and speak again.',
    );
    expect(
      formatGlobalDictationPasteFailure(
        new Error('xdotool is required for dictation paste on Linux: synthetic path'),
      ),
    ).toBe(
      'The action failed, sir. Action: Global dictation paste. ' +
        'Cause: Linux dictation paste requires xdotool. ' +
        'Install xdotool, restore focus to the target app, then retry.',
    );
    expect(formatGlobalDictationPasteFailure(new Error('synthetic private paste detail'))).toBe(
      'The action failed, sir. Action: Global dictation paste. ' +
        'Cause: The transcript could not be pasted into the selected text field. ' +
        'Restore focus and confirm input permission, then retry.',
    );
  });

  it('closes every overlay and batch-session thrown-detail boundary', () => {
    const overlay = readFileSync(
      resolve(process.cwd(), 'src/features/global-dictation/GlobalDictationOverlay.tsx'),
      'utf8',
    );
    const session = readFileSync(
      resolve(process.cwd(), 'src/features/global-dictation/dictationSession.ts'),
      'utf8',
    );
    const unsafeThrownForwarding =
      /(?:String|JSON\.stringify)\s*\(\s*err\s*\)|\$\{\s*err\s*\}|err\s*\.\s*(?:message|toString)\b/gu;

    expect(overlay).toContain('formatGlobalDictationStartupFailure(err)');
    expect(overlay).toContain('formatGlobalDictationSessionFailure(message)');
    expect(overlay).toContain('formatGlobalDictationPasteFailure(err)');
    expect(overlay).not.toMatch(unsafeThrownForwarding);
    expect(session).toContain('formatGlobalDictationTranscriptionFailure(engine)');
    expect(session).not.toMatch(unsafeThrownForwarding);
  });
});
