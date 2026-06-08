# Jarvis One 0.1.26

Terminal stability and latest-download repair.

## Fixed

- Split ANSI/OSC terminal control sequences no longer persist as visible text such as `[0m` or `]10;rgb`.
- Legacy corrupted terminal snapshots are sanitized before restore.
- PTY UTF-8 decoding now holds incomplete multibyte characters across backend reads.
- The GitHub installer path can now move past the older `v0.1.25` release by publishing this newer build.

## Improved

- Terminal output rendering and transcript capture are batched per animation frame for smoother high-volume output.
- Terminal restore keeps the existing UI and workflow while protecting saved session text.
