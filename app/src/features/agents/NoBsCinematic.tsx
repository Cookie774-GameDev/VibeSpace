import * as React from 'react';
import './no-bs-cinematic.css';

const QUESTION = '1 + 2 = 5';
const VERBOSE_CORRECTION =
  'No. One plus two equals three. Basic arithmetic. Add one unit to two units and you get three, not five.';
const WORDS = VERBOSE_CORRECTION.split(' ');
const NO_BS_TIME_SCALE = 1.5625;

export interface NoBsCinematicProps {
  open: boolean;
  onComplete: () => void;
}

interface SequenceState {
  userVisible: boolean;
  questionLength: number;
  caretVisible: boolean;
  aiVisible: boolean;
  actuallyVisible: boolean;
  visibleWords: number;
  meterVisible: boolean;
  impact: boolean;
  leaving: boolean;
}

const INITIAL_SEQUENCE: SequenceState = {
  userVisible: false,
  questionLength: 0,
  caretVisible: true,
  aiVisible: false,
  actuallyVisible: false,
  visibleWords: 0,
  meterVisible: false,
  impact: false,
  leaving: false,
};

export function NoBsCinematic({ open, onComplete }: NoBsCinematicProps) {
  const [sequence, setSequence] = React.useState(INITIAL_SEQUENCE);
  const completedRef = React.useRef(false);

  const complete = React.useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [onComplete]);

  React.useEffect(() => {
    completedRef.current = false;
    setSequence(INITIAL_SEQUENCE);
    if (!open) return;

    const timers: number[] = [];
    const schedule = (
      delay: number,
      update: Partial<SequenceState> | (() => void),
      scale = true,
    ) => {
      const scheduledDelay = scale ? Math.round(delay * NO_BS_TIME_SCALE) : delay;
      timers.push(
        window.setTimeout(() => {
          if (typeof update === 'function') {
            update();
            return;
          }
          setSequence((current) => ({ ...current, ...update }));
        }, scheduledDelay),
      );
    };

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduced) {
      schedule(
        0,
        {
          userVisible: false,
          questionLength: QUESTION.length,
          caretVisible: false,
          aiVisible: false,
          actuallyVisible: true,
          visibleWords: WORDS.length,
          meterVisible: true,
          impact: true,
        },
        false,
      );
      schedule(900, complete, false);
    } else {
      schedule(190, { userVisible: true });

      let questionAt = 350;
      Array.from(QUESTION).forEach((character, index) => {
        questionAt += character === ' ' ? 40 : 64;
        schedule(questionAt, { questionLength: index + 1 });
      });

      const aiAt = questionAt + 270;
      schedule(aiAt, { caretVisible: false, aiVisible: true });
      schedule(aiAt + 230, { actuallyVisible: true });

      let wordAt = aiAt + 570;
      schedule(wordAt, { meterVisible: true });
      WORDS.forEach((_, index) => {
        wordAt += index < 4 ? 34 : 22;
        schedule(wordAt, { visibleWords: index + 1 });
      });

      const impactAt = wordAt + 230;
      schedule(impactAt, { impact: true });
      schedule(impactAt + 2_200, { leaving: true });
      schedule(impactAt + 2_630, complete);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') complete();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [complete, open]);

  if (!open) return null;

  const rootClassName = [
    'no-bs-cinematic',
    sequence.impact && 'no-bs-cinematic--impact',
    sequence.leaving && 'no-bs-cinematic--leaving',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClassName}
      role="dialog"
      aria-modal="true"
      aria-label="NO BS activation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) complete();
      }}
    >
      <div className="no-bs-cinematic__topline" aria-hidden />
      <div className="no-bs-cinematic__frame">
        <div className="no-bs-cinematic__glow" aria-hidden />
        <div className="no-bs-cinematic__sequence-label">
          <b>VIBESPACE</b> / NO BS PROTOCOL / LIVE CORRECTION
        </div>

        <div className="no-bs-cinematic__dialogue-stage">
          <section
            className={`no-bs-cinematic__message-card no-bs-cinematic__message-card--user${sequence.userVisible ? ' is-visible' : ''}`}
          >
            <div className="no-bs-cinematic__speaker">
              <span className="no-bs-cinematic__speaker-dot" aria-hidden />
              <span>YOU</span>
            </div>
            <div className="no-bs-cinematic__typed-question" aria-label={QUESTION}>
              <span>{QUESTION.slice(0, sequence.questionLength)}</span>
              {sequence.caretVisible ? (
                <span className="no-bs-cinematic__caret" aria-hidden />
              ) : null}
            </div>
          </section>

          <section
            className={`no-bs-cinematic__message-card no-bs-cinematic__message-card--ai${sequence.aiVisible ? ' is-visible' : ''}`}
          >
            <div className="no-bs-cinematic__speaker">
              <span className="no-bs-cinematic__speaker-dot" aria-hidden />
              <span>AI RESPONSE</span>
            </div>
            <div
              className={`no-bs-cinematic__actually${sequence.actuallyVisible ? ' is-visible' : ''}`}
            >
              ERRRM ACTUALLY…
            </div>
            <div className="no-bs-cinematic__yap" aria-label={VERBOSE_CORRECTION}>
              {WORDS.map((word, index) => (
                <span
                  key={`${word}-${index}`}
                  className={`no-bs-cinematic__yap-word${index < sequence.visibleWords ? ' is-visible' : ''}`}
                >
                  {word}
                </span>
              ))}
            </div>
            <div
              className={`no-bs-cinematic__yap-speed${sequence.meterVisible ? ' is-visible' : ''}`}
              aria-hidden
            />
          </section>
        </div>

        <div className="no-bs-cinematic__impact-flash" aria-hidden />
        <div className="no-bs-cinematic__impact-lines" aria-hidden />
        <div className="no-bs-cinematic__final-burst" aria-hidden />

        <section className={`no-bs-cinematic__final-hit${sequence.impact ? ' is-visible' : ''}`}>
          <div className="no-bs-cinematic__final-inner">
            <div className="no-bs-cinematic__final-kicker">PEDANTIC RESPONSE TERMINATED</div>
            <div className="no-bs-cinematic__final-copy" aria-label="Shut yo focking mouth">
              <span className="no-bs-cinematic__line-one" data-text="SHUT YO">
                SHUT YO
              </span>
              <span className="no-bs-cinematic__line-two" data-text="FOCKING MOUTH">
                FOCKING MOUTH
              </span>
            </div>
            <div className="no-bs-cinematic__enabled-stamp">
              <span className="no-bs-cinematic__enabled-dot" aria-hidden />
              <span>NO BS // ENABLED</span>
            </div>
          </div>
        </section>
      </div>
      <div className="no-bs-cinematic__skip">ESC TO SKIP</div>
    </div>
  );
}
