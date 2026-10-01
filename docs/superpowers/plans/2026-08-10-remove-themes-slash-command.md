# Remove the `/themes` Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `/themes` completely while preserving `/appearance` for global appearance and `/theme` for chat-console profiles.

**Architecture:** Keep the existing command registry and composer flow. Narrow the global appearance command contract to the single canonical command `appearance`, then update picker typing and user-facing help to match.

**Tech Stack:** React, TypeScript, Vitest, Testing Library.

## Global Constraints

- Do not modify theme assets, appearance settings, or `/theme` behavior.
- Do not touch unrelated dirty benchmark, news, or worker files.
- `/themes` must be absent from discovery and must not be intercepted during execution.

---

### Task 1: Remove the duplicate command

**Files:**
- Modify: `app/src/features/chat/SlashCommandTypeahead.test.ts`
- Modify: `app/src/features/chat/SlashCommandTypeahead.tsx`
- Modify: `app/src/features/chat/themeSlashPicker.tsx`
- Modify: `app/src/features/chat/themeSlashPicker.test.tsx`
- Modify: `app/src/features/chat/Composer.tsx`
- Modify: `app/src/features/chat/Composer.theme.test.tsx`
- Modify: `app/src/features/chat/Composer.paths.test.ts`

**Interfaces:**
- Consumes: `findSlashCommandDef(command: string)` and `isGlobalThemePickerCommand(command: string)`.
- Produces: a single global appearance slash-command path through `/appearance`.

- [ ] **Step 1: Write the failing registry and recognition tests**

Change the command-contract test to assert:

```ts
expect(findSlashCommandDef('themes')).toBeUndefined();
expect(findSlashCommandDef('appearance')).toMatchObject({
  cmd: 'appearance',
  category: 'utility',
  takesArg: true,
  hasOptions: true,
});
expect(isGlobalThemePickerCommand('themes')).toBe(false);
expect(isGlobalThemePickerCommand('appearance')).toBe(true);
```

The production mutation caught is re-registering or recognizing `/themes`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm exec vitest run src/features/chat/SlashCommandTypeahead.test.ts src/features/chat/themeSlashPicker.test.tsx
```

Expected: failure because current production still registers and recognizes `themes`.

- [ ] **Step 3: Implement the minimal removal**

- Delete the `cmd: 'themes'` registry entry.
- Make `isGlobalThemePickerCommand` return true only for `appearance`.
- Narrow `ThemeSlashPickerProps.commandLabel` to `'appearance'`.
- Make the composer execution branch recognize only `cmd === 'appearance'`.
- Narrow the picker cast to `'appearance'`.
- Change appearance help to `Use /appearance to choose.`
- Update existing picker and help-text fixtures from `themes` to `appearance`.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```powershell
pnpm exec vitest run src/features/chat/SlashCommandTypeahead.test.ts src/features/chat/themeSlashPicker.test.tsx src/features/chat/Composer.theme.test.tsx src/features/chat/Composer.paths.test.ts
```

Expected: all collected tests pass.

- [ ] **Step 5: Run static and diff verification**

Run:

```powershell
pnpm run typecheck
pnpm exec prettier --check src/features/chat/SlashCommandTypeahead.tsx src/features/chat/SlashCommandTypeahead.test.ts src/features/chat/themeSlashPicker.tsx src/features/chat/themeSlashPicker.test.tsx src/features/chat/Composer.tsx src/features/chat/Composer.theme.test.tsx src/features/chat/Composer.paths.test.ts
git diff --check
git diff -- app/src/features/chat
```

Expected: zero TypeScript errors, formatting passes, no whitespace errors, and no unrelated file changes in the scoped diff.

- [ ] **Step 6: Commit the implementation**

Stage only the seven chat files and commit:

```powershell
git commit -m "fix(chat): remove duplicate themes command"
```
