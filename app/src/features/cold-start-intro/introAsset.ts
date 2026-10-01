/** Bundled cold-start cinematic intro (native 4K, 6s, H.264 + AAC). */
export const COLD_START_INTRO_VIDEO_SRC = '/intro/VibeSpace_Pixel_Intro_Enhanced.mp4';

/** Exact authored duration in milliseconds. */
export const COLD_START_INTRO_DURATION_MS = 6000;

/** Absolute fail-open deadline for stalled loading, decode, or playback. */
export const COLD_START_INTRO_HARD_TIMEOUT_MS = 8000;

/** Crossfade into the main shell after intro completion or skip. */
export const COLD_START_INTRO_CROSSFADE_MS = 150;

/** Fallback hold when decode fails before revealing the main window. */
export const COLD_START_INTRO_FAILURE_HOLD_MS = 400;

/** Native Tauri window label for the intro surface. */
export const COLD_START_INTRO_WINDOW_LABEL = 'cold-start-intro';

/** Main application window label. */
export const MAIN_WINDOW_LABEL = 'main';
