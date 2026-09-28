## [ERR-20260928-VI01] vitest-dom-matcher-and-test-placement

**Logged**: 2026-09-28
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The focused settings test first used an unavailable matcher and then placed a persistence assertion in the provider-only test.

### Error
`Invalid Chai property: toHaveValue`; after replacing it with the input DOM value, the first persistence assertion failed because it was attached to a test that had not changed those fields.

### Context
- Command: `npm run test -- src/features/settings/sections/Voice.agentProviders.test.tsx src/features/voice/Orb.test.tsx --maxWorkers=1`
- The application uses Vitest/Chai without the jest-dom matcher. The persistence expectation was moved to the test that changes Main chat, Worker session, and mini-bar values.

### Suggested Fix
Use native DOM properties when matcher availability is unknown, and keep persistence assertions beside the test actions that write the persisted values.

### Resolution
- Resolved in the same task; focused suite passed 2 files / 11 tests.

### Metadata
- Reproducible: yes
- Related Files: app/src/features/settings/sections/Voice.agentProviders.test.tsx
- See Also: none

## [ERR-20260928-VI01-PATCH] evidence-patch-line-endings

**Logged**: 2026-09-28
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The first saved patch receipt used PowerShell output with CRLF patch records and `git apply --reverse --check` rejected the evidence patch.

### Error
`git apply --reverse --check` reported context failures across the included files. Source files were unchanged.

### Context
- Captured the scoped `git diff --binary` through `Out-File`; the output had CRLF records.
- Regenerated the evidence patch as UTF-8 without BOM and LF line endings using `File.WriteAllText`.

### Suggested Fix
When saving a Git patch from PowerShell for later application, normalize the captured diff text to LF before writing.

### Resolution
- Reverse-apply check passed for the regenerated patch.
- SHA256: `6CC882A2E27E7B3B91AB0950F2C68F15B3988F74AE3429829F3E7488759165C0`.

### Metadata
- Reproducible: yes
- Related Files: work/settings-voice-visuals-VI01/owned-final.patch
- See Also: none
