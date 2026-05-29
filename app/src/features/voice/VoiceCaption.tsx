import { AnimatePresence, motion } from 'motion/react';
import { useVoiceStore } from './store';

/**
 * Translucent caption bar that overlays the bottom of the screen during
 * voice sessions. Per docs/05 sec 5: "a translucent transcript caption
 * at the bottom of the screen showing what Jarvis heard. Drops away when
 * the session ends."
 *
 * Behaviour:
 *  - shows the live partial transcript while it has content
 *  - falls back to the most recent finalised utterance otherwise
 *  - hides entirely when there's nothing to display
 *
 * Mount at App root, NOT inside the modal - the caption is for sessions
 * that happen with the modal closed (ambient-mode dictation, future PTT).
 */
export function VoiceCaption() {
  const partial = useVoiceStore((s) => s.partialTranscript);
  const finals = useVoiceStore((s) => s.finalTranscript);
  const last = finals[finals.length - 1];

  // Prefer live partial, then last final (briefly, for continuity).
  const text = partial.trim() || last?.text || '';
  const visible = !!text;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[55] flex justify-center px-6"
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            key="caption"
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32, mass: 0.7 }}
            className="pointer-events-auto max-w-3xl rounded-full border border-border/60 bg-elevated/80 px-5 py-2.5 text-body text-foreground shadow-lg backdrop-blur-md"
          >
            <span className="line-clamp-2">{text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
