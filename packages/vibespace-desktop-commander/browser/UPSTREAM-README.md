# Plugin 2 Codex kit — no-restart companion

This is an additive local extension to @2, not a replacement for Codex and not a native-tool schema upgrade. The active Desktop Commander server, tunnel, watchdog, @1, default Playwright, and VibeSpace repositories are not changed. Invoke the helper through @2 `start_process`; no restart or reconnection is needed. It does not increase the model's context, remove transport limits, add a sandbox, or create API credits.

## Entry point

```powershell
node "C:\Users\viper\Documents\Codex\Plugin-2\extensions\codex-kit\p2.mjs" doctor
```

Commands below abbreviate that full path as `p2.mjs`. Use absolute paths in real calls. Windows PowerShell quoting is easier with `--filename` for Playwright code and JSON files for repository requests. If a call times out, inspect its output/state before retrying; never blindly replay mutations.

## Browser control — official Playwright CLI

Locally pinned `@playwright/cli@0.1.19`, not a global install. Its upstream dependency is `playwright@1.63.0-alpha-2026-08-31`; the exact dependency tree and integrity hashes are in package-lock.json. The package is official but includes prerelease internals; targeted passing tests are not a long-term stability certification. Updates are manual, not automatic.

```powershell
node p2.mjs browser --session task42 open https://example.com
node p2.mjs browser --session task42 snapshot
node p2.mjs browser --session task42 click e12
node p2.mjs browser --session task42 fill e8 "Sample input"
node p2.mjs browser --session task42 press Enter
node p2.mjs browser --session task42 mousemove 300 200
node p2.mjs browser --session task42 mousedown
node p2.mjs browser --session task42 mousemove 500 250
node p2.mjs browser --session task42 mouseup
node p2.mjs browser --session task42 mousewheel 0 600
node p2.mjs browser --session task42 screenshot
```

Use `open URL --headed` for a visible dedicated Edge window. Default is headless. Each task has its own `p2-` session, workspace, in-memory profile, screenshots and logs. The browser cursor is separate from your physical desktop cursor. Use `read_file` on returned image paths to inspect screenshots. Re-snapshot before using stale element references. `run-code --filename=ABSOLUTE.js` supports focused Playwright scripts, assertions and coordinate clicks such as `await page.mouse.click(300,200)`. Consult installed CLI help for exact command syntax.

An opened or interrupted-open session cannot be opened again: use goto/snapshot or a new name. The wrapper blocks `close`, `close-all`, `kill-all`, `tab-close`, profile deletion, attach/detach, and configuration/session overrides. It never attaches to your ordinary browser or another agent's native-app CDP endpoint. This guard is not a security sandbox: arbitrary Playwright code can still perform powerful actions. Do not use code to bypass the no-close intent. For explicitly authorized native-app testing, use the existing dedicated app connection rather than silently attaching this browser helper.

Commands in one session are serialized with a lock. A busy session refuses a second command, instead of racing it. The wrapper does not kill a browser after a timeout. If a wrapper is interrupted, inspect its recorded PID and session before removing `command.lock`. Never clear a live lock. Use separate session names across parallel agents.

Browser output and diagnostics remain under `workspaces\TASK\artifacts`; do not dump full network bodies, cookies, passwords or storage state into chat. Action audit stores command names, timings and exit codes, not typed arguments. Browser traces/screenshots can still contain sensitive page content. Artifacts and backups are retained locally and are not automatically deleted. Uploading files, submitting forms, purchases, account changes and publication require task-specific user authorization.

## Large repositories and files

The original @2 reader already supports byte-paged reads and guarded text editing through 64 MiB. This companion adds one-MiB streaming buffers for staged replacements through one GiB/file, up to 500 target files and four GiB combined input/backup size per batch. These are enforced limits, not a recommendation to send huge tool messages. The source file lives on disk: do not send a gigabyte in a tool call. Available disk space and filesystem behavior still apply.

A manifest:

```json
{
  "root": "C:\\absolute\\repo",
  "changes": [{
    "path": "src/example.ts",
    "source": "C:\\absolute\\staged\\example.ts",
    "expectedSha256": "FULL_SHA256_OF_CURRENT_TARGET",
    "sourceSha256": "FULL_SHA256_OF_STAGED_SOURCE"
  }]
}
```

Use `files hash ABSOLUTE_PATH` for hashes. `expectedSha256: null` explicitly means create a new target; its parent must already exist. Omitted hashes are rejected. Sources and targets must be ordinary files; symlinks, junctions, hardlinks, traversal, reserved Windows names and .git edits are rejected.

```powershell
node p2.mjs files plan C:\absolute\changes.json
node p2.mjs files apply C:\absolute\changes.json
node p2.mjs files rollback C:\absolute\receipt.json
```

`plan` changes no targets. `apply` preflights every file, copies verified backups and stages, flushes data, rechecks hashes, then replaces files and returns a receipt. This is **journaled, not atomic across multiple files**. A process interruption can leave some files committed; inspect the receipt and explicitly rollback. Rollback verifies current hashes and refuses to overwrite newer edits. Restored backups remain on disk. A persistent lock after a crash is intentional: investigate before clearing it. Filesystem ACL preservation, network shares, unusual filesystems and crash/power-loss durability are not fully certified.

Only companion operations honor its workspace lock. Other editors and ordinary @2 edits can still race a commit. For parallel agents, separate Git worktrees remain the recommended isolation mechanism. Do not mix tools concurrently on the same files.

## Streaming exact replacement

`files replace REQUEST.json` creates a separate derived file; it never directly rewrites the source. Request fields: `source`, `output` (new absolute path), `expectedSha256`, `old` (nonempty UTF-8 literal), `new`, `expectedReplacements` (positive exact count). The helper handles matches across chunk boundaries, validates UTF-8, preserves unchanged bytes/BOM/newlines, and refuses existing output paths. To publish, put the generated file and returned hash into a batch manifest. Patterns and replacements are limited to one MiB each. No regex or fuzzy replacement is performed.

## Git helpers

```powershell
node p2.mjs files git-status C:\repo
node p2.mjs files git-check-patch C:\repo C:\staged\change.patch
node p2.mjs files git-worktree C:\repo C:\new-worktree p2/task42
```

Worktree creation needs an existing parent and unused destination/branch. It creates a new `p2/` branch from HEAD. It never stashes, resets, force-checks out, commits, pushes, or deletes existing changes. Patch checking does not apply the patch. These helpers do not automatically connect a GitHub account.

## Windows desktop observation

```powershell
node p2.mjs desktop windows
node p2.mjs desktop screenshot 123456
```

Window inventory and visible-window-region screenshots are read-only and do not focus, close or move apps. Overlapping windows can appear in a screen-region capture. Native whole-desktop mouse/keyboard injection is intentionally not enabled: it would compete with your physical cursor and other agents. Website cursor control is fully handled in the isolated Playwright browser instead. Elevated apps, UAC, lock screens and hidden-window contents are not bypassed.

## Verification and rollback of this extension

Run `node --test tests/browser.test.mjs` and `python -X utf8 -m unittest discover -s tests -p "test_*.py" -v` from this directory. Runtime browser smoke testing is recorded separately. Unit tests use temporary fixtures only.

This additive kit does not require restoring the core server to stop using it. Stop calling its entry point; the original @2 tools remain active. Do not restart or use the older core rollback launcher for this extension. Full pre-change code/config backup and manifests are in the September 5 codex-kit upgrade folder. Keep the browser session open until the user authorizes closing it. Removing extension files while a helper is running is unsafe.

## Research sources

- Microsoft Playwright CLI: https://github.com/microsoft/playwright-cli
- Playwright coding-agent guide: https://playwright.dev/docs/getting-started-cli
- Playwright vision tools: https://playwright.dev/mcp/vision-mode
- Git worktrees: https://git-scm.com/docs/git-worktree
- Git patch checking: https://git-scm.com/docs/git-apply
- Windows input limitations: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- Codex architecture and worktrees: https://openai.com/index/introducing-the-codex-app/
- Codex Windows sandbox: https://openai.com/index/building-codex-windows-sandbox/
