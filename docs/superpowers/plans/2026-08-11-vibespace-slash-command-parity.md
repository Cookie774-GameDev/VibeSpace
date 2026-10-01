# VibeSpace Slash-Command Parity Implementation Plan

> Execute sequentially in the Phase 12 worktree. Preserve unrelated dirty work
> and stage only the paths owned by the active coordination record.

## Task 1: Freeze the Section 20 classifier

**Files**

- Create `app/src/features/chat/slashCommandRouting.ts`
- Create `app/src/features/chat/slashCommandRouting.test.ts`

1. Write a failing exact matrix test for every canonical Section 20 command,
   its owner, execution kind, and all current typo-compatible aliases.
2. Implement the pure classifier and exported alias table.
3. Verify the focused test.
4. Commit only these files.

## Task 2: Unify discovery and alias normalization

**Files**

- Modify `app/src/features/chat/SlashCommandTypeahead.tsx`
- Modify `app/src/features/chat/SlashCommandTypeahead.test.ts`

1. Add failing tests proving the visible catalog and classifier have identical
   canonical commands except gated Hive, and `/themes` resolves to `/theme`.
2. Import the classifier alias authority into the typeahead.
3. Verify typeahead and agent selector tests.
4. Commit only these files.

## Task 3: Repair direct command execution

**Files**

- Modify `app/src/features/chat/Composer.tsx`
- Modify `app/src/features/chat/Composer.paths.test.ts`
- Modify `app/src/features/chat/markdownCommand.ts`
- Create `app/src/features/chat/markdownCommand.test.ts`
- Modify `app/src/features/chat/slashProjectFiles.ts`
- Modify `app/src/features/chat/slashProjectFiles.test.ts`

1. Add failing pure tests for direct Markdown parsing, absolute attachment
   validation, and schedule/reference forwarding without raw slash syntax.
2. Gate `Composer` dispatch through the central classifier.
3. Implement typed plugin, skill, Markdown, schedule, and safe attachment
   paths using existing VibeSpace stores and pickers.
4. Verify focused Composer, Markdown, attachment, mode, undo/redo, model,
   usage, active-agent, and typeahead suites.
5. Commit only owned implementation/test files.

## Task 4: Complete the matrix and release

**Files**

- Modify `C:\Users\viper\VibeSpace\AGENT_COORDINATION.md`
- Modify `.agent-coordination.lock/owner.txt`

1. Run all focused chat slash-command suites.
2. Run TypeScript typecheck, production build, Prettier, and
   `git diff --check`.
3. Scan changed command paths for raw VibeSpace slash forwarding and compare
   the Section 20 matrix to the registered typeahead catalog.
4. Record the automatic and manual matrix evidence in central coordination.
5. Mark the owner record `RELEASED` and commit only that release record.
