import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COLD_START_INTRO_CROSSFADE_MS,
  COLD_START_INTRO_FAILURE_HOLD_MS,
  COLD_START_INTRO_HARD_TIMEOUT_MS,
  COLD_START_INTRO_VIDEO_SRC,
  COLD_START_INTRO_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
} from './introAsset';
import { createDoubleEscapeSkipState, noteEscapeKeyEvent } from './doubleEscapeSkip';

type FinishReason = 'ended' | 'skipped' | 'failed';

/**
 * Fullscreen cinematic cold-start intro.
 * Mounted only in the dedicated `cold-start-intro` native window.
 */
export function ColdStartIntroView() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const finishedRef = useRef(false);
  const escapeStateRef = useRef(createDoubleEscapeSkipState());
  const [fading, setFading] = useState(false);
  const [failed, setFailed] = useState(false);

  const finish = useCallback(async (reason: FinishReason) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFading(true);

    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
    }

    // Brief crossfade hold, then hand off to the main window.
    await new Promise((r) => window.setTimeout(r, COLD_START_INTRO_CROSSFADE_MS));

    const warn = (operation: string) => {
      console.warn(`[cold-start-intro] finish (${reason}) ${operation} failed`);
    };

    let main: Awaited<
      ReturnType<(typeof import('@tauri-apps/api/webviewWindow'))['WebviewWindow']['getByLabel']>
    > = null;
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      main = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    } catch {
      warn('main-window lookup');
    }

    if (main) {
      try {
        await main.show();
      } catch {
        warn('main-window show');
      }
      try {
        await main.unminimize();
      } catch {
        warn('main-window unminimize');
      }
      try {
        await main.setFocus();
      } catch {
        warn('main-window focus');
      }
    }

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const current = getCurrentWindow();
      if (current.label === COLD_START_INTRO_WINDOW_LABEL) {
        await current.close();
      }
    } catch {
      warn('intro-window close');
    }
  }, []);

  useEffect(() => {
    // Capture keyboard focus so double-Escape works without OS chrome.
    try {
      window.focus();
      document.body.focus();
    } catch {
      /* ignore */
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (noteEscapeKeyEvent(escapeStateRef.current, event)) {
        event.preventDefault();
        event.stopPropagation();
        void finish('skipped');
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [finish]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void finish('failed');
    }, COLD_START_INTRO_HARD_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [finish]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const play = async () => {
      try {
        video.currentTime = 0;
        await video.play();
      } catch (err) {
        console.warn('[cold-start-intro] autoplay/play failed:', err);
        setFailed(true);
        window.setTimeout(() => {
          void finish('failed');
        }, COLD_START_INTRO_FAILURE_HOLD_MS);
      }
    };

    void play();
  }, [finish]);

  return (
    <div
      data-testid="cold-start-intro"
      data-cold-start-intro="true"
      tabIndex={-1}
      style={{
        position: 'fixed',
        inset: 0,
        margin: 0,
        padding: 0,
        overflow: 'hidden',
        background: '#050608',
        cursor: 'none',
        opacity: fading ? 0 : 1,
        transition: `opacity ${COLD_START_INTRO_CROSSFADE_MS}ms linear`,
        outline: 'none',
        userSelect: 'none',
      }}
    >
      <video
        ref={videoRef}
        src={COLD_START_INTRO_VIDEO_SRC}
        playsInline
        autoPlay
        // Muted is intentionally OFF — preserve authored AAC audio.
        muted={false}
        controls={false}
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
        onEnded={() => {
          void finish('ended');
        }}
        onError={() => {
          setFailed(true);
          window.setTimeout(() => {
            void finish('failed');
          }, COLD_START_INTRO_FAILURE_HOLD_MS);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#050608',
          display: failed ? 'none' : 'block',
        }}
      />
      {/* Fail-closed static hold: dark field sampled from intro grade. */}
      {failed ? (
        <div
          data-testid="cold-start-intro-fallback"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(circle at 50% 40%, #1a1f2a 0%, #050608 70%)',
          }}
        />
      ) : null}
    </div>
  );
}

export default ColdStartIntroView;
