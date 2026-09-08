# Windows input deadlock backport

Base: crates.io Tao 0.35.3, checksum `d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`.

The four Windows implementation files contain the unmodified source changes from
[upstream commit c704261c519c58cfdd0bc2d58ba24e06a0b71c92](https://github.com/tauri-apps/tao/commit/c704261c519c58cfdd0bc2d58ba24e06a0b71c92),
[PR #1215](https://github.com/tauri-apps/tao/pull/1215).
The patch moves reentrant Win32 message peeks outside input-state locks.
VibeSpace native testing reproduced the recursive keyboard mutex deadlock.

Retain upstream licenses. Remove this patch when the Tauri runtime permits a Tao
release containing the fix (released in Tao 0.36.0). No public APIs or non-Windows
implementation files were changed.
