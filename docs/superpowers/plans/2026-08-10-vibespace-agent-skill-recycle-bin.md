# VibeSpace Agent and Skill Recycle Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This task is explicitly inline-only; do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an account-isolated recycle bin for user-created agents and custom skills with accessible confirmation, exact 90-day recovery, restore, and confirmed permanent deletion in Settings General.

**Architecture:** A bounded account-scoped external store retains validated deleted snapshots. A lifecycle service sequences archive persistence with existing Agent and Skill repositories, including compensation and conflict-safe restore. Shared confirmation UI connects AgentManager, SkillEditor, and a live Settings General recycle-bin surface.

**Tech Stack:** React 19, TypeScript, Zustand, Radix Dialog, Vitest, Testing Library, IndexedDB repositories, account-scoped localStorage.

## Global Constraints

- Built-in agents and built-in preset skills remain protected.
- Retention is exactly `90 * 24 * 60 * 60 * 1000` milliseconds.
- Cancel is initially focused in every destructive confirmation dialog.
- No raw archive payload, name, ID, or storage error is logged.
- Account A must never read, restore, purge, or empty account B’s recycle bin.
- No database schema, backend, native, dependency, auth, billing, news, benchmark, chat, or unrelated dirty-work changes.
- Use strict RED → GREEN cycles for every production behavior.

---

### Task 1: Account-scoped recycle-bin store

**Files:**
- Create: `app/src/features/recycle-bin/recycleBinStore.ts`
- Create: `app/src/features/recycle-bin/recycleBinStore.test.ts`

**Interfaces:**
- Consumes: `getActiveAccountIdentity`, `Agent`, `AgentId`, `CustomSkillRecord`
- Produces: `RecycleBinItem`, `RECYCLE_BIN_RETENTION_MS`, `recycleBinStore`

- [ ] **Step 1: Write the failing retention and account-isolation tests**

```ts
it('keeps an archive before 90 days and removes it at the exact boundary', () => {
  const deletedAt = Date.parse('2026-08-10T12:00:00.000Z');
  recycleBinStore.archiveSkill(skill, deletedAt);
  recycleBinStore.pruneExpired(deletedAt + RECYCLE_BIN_RETENTION_MS - 1);
  expect(recycleBinStore.getSnapshot()).toHaveLength(1);
  recycleBinStore.pruneExpired(deletedAt + RECYCLE_BIN_RETENTION_MS);
  expect(recycleBinStore.getSnapshot()).toEqual([]);
});

it('clears account A from memory before loading account B', () => {
  setIdentity('account-a');
  recycleBinStore.archiveSkill(skill, 1000);
  setIdentity('account-b');
  recycleBinStore.refreshScope();
  expect(recycleBinStore.getSnapshot()).toEqual([]);
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run:

```powershell
npm run test -- --run src/features/recycle-bin/recycleBinStore.test.ts --maxWorkers=1
```

Expected: FAIL because `recycleBinStore.ts` does not exist.

- [ ] **Step 3: Implement the bounded observable store**

Implement:

```ts
export const RECYCLE_BIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type RecycleBinItem =
  | {
      archiveId: string;
      kind: 'agent';
      entityId: AgentId;
      name: string;
      deletedAt: number;
      expiresAt: number;
      payload: Agent;
    }
  | {
      archiveId: string;
      kind: 'skill';
      entityId: string;
      name: string;
      deletedAt: number;
      expiresAt: number;
      payload: CustomSkillRecord;
    };
```

Use a versioned account key, memory-only session scope, persist-before-publish,
bounded recovery, duplicate archive rejection, exact-boundary pruning, and
`subscribe/getSnapshot/refreshScope`.

- [ ] **Step 4: Add malformed-data and failed-write tests**

Cover oversized arrays/text, prototype keys, duplicate archive IDs, invalid
dates, and a throwing `localStorage.setItem`. The expected state remains the
last committed snapshot.

- [ ] **Step 5: Run the store tests and verify GREEN**

Run the Task 1 command. Expected: all tests pass with no warnings.

### Task 2: Exact custom-skill restoration seam

**Files:**
- Modify: `app/src/features/skills/skillsStore.ts`
- Modify: `app/src/features/skills/skillsStore.accountIsolation.test.ts`

**Interfaces:**
- Consumes: validated `CustomSkillRecord`
- Produces: `getCustomSkill(id)`, `restoreCustomSkill(record)`

- [ ] **Step 1: Write failing real-store tests**

```ts
it('restores the exact custom skill identity and content once', () => {
  const original = readSkillsStore().getCustomSkill(createdId)!;
  readSkillsStore().removeCustomSkill(createdId);
  readSkillsStore().restoreCustomSkill(original);
  expect(readSkillsStore().getCustomSkill(createdId)).toEqual(original);
  expect(() => readSkillsStore().restoreCustomSkill(original)).toThrow(
    'A skill with this identity already exists.',
  );
});

it('does not publish removal when persistence fails', () => {
  localStorageSetItem.mockImplementationOnce(() => {
    throw new DOMException('storage unavailable');
  });
  expect(() => readSkillsStore().removeCustomSkill(createdId)).toThrow();
  expect(readSkillsStore().getCustomSkill(createdId)).toBeDefined();
});
```

- [ ] **Step 2: Run the focused Skills store test and verify RED**

Expected: missing methods and current publish-before-persist behavior fail.

- [ ] **Step 3: Implement exact-record access and persist-before-publish**

Normalize the next catalog, persist it using its explicit scope key, and only
then call Zustand `set`. `restoreCustomSkill` rejects an occupied ID and
prepends the validated record unchanged.

- [ ] **Step 4: Run Skills store tests and verify GREEN**

Run:

```powershell
npm run test -- --run src/features/skills/skillsStore.accountIsolation.test.ts --maxWorkers=1
```

### Task 3: Connected deletion and restoration service

**Files:**
- Create: `app/src/features/recycle-bin/recycleBinService.ts`
- Create: `app/src/features/recycle-bin/recycleBinService.test.ts`

**Interfaces:**
- Consumes: `recycleBinStore`, `agentRepo`, `useAgentStore`, `readSkillsStore`, `skillRegistry`
- Produces:

```ts
moveAgentToRecycleBin(agent: Agent): Promise<void>;
moveSkillToRecycleBin(skill: CustomSkillRecord): void;
restoreRecycleBinItem(item: RecycleBinItem): Promise<{
  restoredId: string;
  conflictCopy: boolean;
}>;
permanentlyDeleteRecycleBinItem(archiveId: string): void;
emptyRecycleBin(): void;
```

- [ ] **Step 1: Write failing sequencing and compensation tests**

Test archive-before-delete, archive rollback on repository failure, custom-skill
registry refresh, active recreation before archive removal, and compensation
when archive removal fails.

- [ ] **Step 2: Write the conflict-safe agent restore test**

Seed an active row using the deleted ID or slug. Restore must create a fresh
`AgentId`, unique `restored_<suffix>` slug, and `<name> (restored)` without
modifying the active collision.

- [ ] **Step 3: Run service tests and verify RED**

Expected: module missing.

- [ ] **Step 4: Implement minimal lifecycle orchestration**

Reject built-ins/presets, use bounded public errors, archive before active
removal, remove archive only after successful restore, and compensate a failed
final archive removal by removing the newly recreated active entity.

- [ ] **Step 5: Run service tests and verify GREEN**

Run:

```powershell
npm run test -- --run src/features/recycle-bin/recycleBinService.test.ts --maxWorkers=1
```

### Task 4: Shared confirmation dialog and deletion entry points

**Files:**
- Create: `app/src/features/recycle-bin/RecycleBinConfirmDialog.tsx`
- Create: `app/src/features/recycle-bin/RecycleBinConfirmDialog.test.tsx`
- Modify: `app/src/features/agents/AgentManager.tsx`
- Modify: `app/src/features/agents/AgentManager.test.tsx`
- Modify: `app/src/features/skills/SkillEditor.tsx`
- Create or modify direct `SkillEditor` deletion test

**Interfaces:**
- Consumes: lifecycle service move functions
- Produces: accessible move/permanent/empty confirmation UI

- [ ] **Step 1: Write dialog accessibility RED tests**

Assert `role="alertdialog"`, linked name/description, Cancel initial focus,
Escape cancellation, one pending action, disabled destructive control while
pending, and bounded visible failure.

- [ ] **Step 2: Write AgentManager and SkillEditor RED tests**

Assert clicking Delete does not mutate immediately; Cancel preserves; confirm
moves custom items; built-in/preset surfaces expose no recycle-delete action.

- [ ] **Step 3: Run focused UI tests and verify RED**

Expected: current agent deletion is immediate and skill deletion uses
`window.confirm`.

- [ ] **Step 4: Implement shared dialog and wire both editors**

Keep dialog state local to each editor, call only service functions, unregister
or refresh through the service, restore focus after close, and show a
90-day-recovery toast after success.

- [ ] **Step 5: Run focused UI tests and verify GREEN**

Run:

```powershell
npm run test -- --run src/features/recycle-bin/RecycleBinConfirmDialog.test.tsx src/features/agents/AgentManager.test.tsx src/features/skills/SkillEditor.recycleBin.test.tsx --maxWorkers=1
```

### Task 5: Settings General recycle-bin surface

**Files:**
- Create: `app/src/features/recycle-bin/RecycleBinSettings.tsx`
- Create: `app/src/features/recycle-bin/RecycleBinSettings.test.tsx`
- Modify: `app/src/features/settings/sections/General.tsx`
- Modify: `app/src/features/settings/sections/General.test.tsx`

**Interfaces:**
- Consumes: observable store, restore/permanent/empty lifecycle functions
- Produces: live combined recycle-bin UI in Settings General

- [ ] **Step 1: Write Settings surface RED tests**

Seed one agent and one skill archive. Assert newest-first rows, type, exact
dates, whole days remaining, Restore, Delete permanently, and Empty Bin.
Assert empty state and account switching.

- [ ] **Step 2: Write destructive-flow RED tests**

Assert per-item permanent delete and Empty Bin each require a second
confirmation; cancellation preserves records; successful restoration removes
the row and recreates the active entity.

- [ ] **Step 3: Run Settings tests and verify RED**

Expected: recycle-bin component missing.

- [ ] **Step 4: Implement the live Settings surface**

Use `useSyncExternalStore`, prune before rendering, semantic tokens, compact
rows, locale dates, and the shared confirmation dialog. Render after existing
General controls without modifying them.

- [ ] **Step 5: Run Settings tests and verify GREEN**

Run:

```powershell
npm run test -- --run src/features/recycle-bin/RecycleBinSettings.test.tsx src/features/settings/sections/General.test.tsx --maxWorkers=1
```

### Task 6: Integration and hygiene

**Files:**
- Modify only files listed above as required by verified failures.

- [ ] **Step 1: Run the complete recycle-bin and adjacent suite**

```powershell
npm run test -- --run src/features/recycle-bin src/features/agents/AgentManager.test.tsx src/features/skills/skillsStore.accountIsolation.test.ts src/features/skills/SkillEditor.recycleBin.test.tsx src/features/skills/SkillsPage.monochromeAppearance.test.tsx src/features/settings/sections/General.test.tsx --maxWorkers=1
```

- [ ] **Step 2: Run app TypeScript**

```powershell
npm run typecheck
```

- [ ] **Step 3: Run exact formatting and diff checks**

Run Prettier on only owned source/test files, then `git diff --check` on the
same paths.

- [ ] **Step 4: Scan exact production additions for secrets and raw logging**

Require zero credential shapes and zero archive payload/name/ID logging.

- [ ] **Step 5: Review the final diff against every approved requirement**

Confirm 90-day boundary, account isolation, built-in protection, dialog
confirmation, restore conflict handling, permanent deletion, Empty Bin, active
registry removal, and unrelated-path preservation.
