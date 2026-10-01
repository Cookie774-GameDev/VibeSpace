# VibeSpace Agent and Skill Recycle Bin Design

**Date:** 2026-08-10
**Status:** Owner approved
**Task:** `VS-ROOT-20260810T204000-AGENT-SKILL-RECYCLE-BIN`

## Goal

VibeSpace will protect user-created agents and custom skills from accidental
deletion. A deletion first opens an accessible confirmation dialog, then moves
the item into an account-isolated recycle bin for exactly 90 days. Settings →
General lets the user inspect, restore, permanently delete, or empty the bin.

Built-in agents and built-in preset skills remain protected. Their existing
factory-reset behavior is unchanged.

## Product behavior

### Delete from Agents or Skills

- Only a user-created agent or custom skill can enter the recycle bin.
- Selecting Delete opens a modal confirmation panel with:
  - the exact item name and type;
  - clear copy that the item remains recoverable for 90 days;
  - Cancel as the initially focused action;
  - a destructive `Move to Recycle Bin` action.
- Cancel, Escape, backdrop dismissal, or closing the dialog changes nothing.
- Confirming archives a validated snapshot before removing the active item.
- A deleted agent immediately disappears from the active Agent roster and
  cannot be selected by orchestration.
- A deleted skill immediately disappears from the Skills library and runtime
  skill catalog. Agent definitions may retain the skill ID so restoring the
  same skill reactivates those references.
- A failed archive operation leaves the active item untouched.
- A failed active-item removal rolls back the new recycle-bin entry.

### Settings → General recycle bin

The new `Recycle Bin` section appears in Settings → General and contains:

- an explanatory 90-day retention notice;
- a combined list of deleted agents and custom skills;
- item type, name, deletion date, expiration date, and whole days remaining;
- `Restore` and `Delete permanently` actions per item;
- `Empty Recycle Bin` when at least one item exists;
- an explicit empty state when no recoverable items exist.

The list is ordered newest deletion first. It updates immediately when another
surface deletes or restores an item.

### Restore

- Restore removes the archive only after the active item has been recreated
  successfully.
- A custom skill restores with its original ID and complete validated content.
- An agent restores with its original ID and slug when neither conflicts.
- If an agent ID or slug is already occupied, restoration creates a
  conflict-safe copy with a fresh agent ID, a unique `restored_…` slug, and
  ` (restored)` appended to the display name. Existing active work is never
  overwritten.
- If active recreation succeeds but archive removal fails, the recreation is
  compensated by deleting the newly recreated active item. The recoverable
  archive remains.
- Restore errors use bounded UI copy and never expose raw persisted payloads.

### Permanent deletion

- `Delete permanently` opens a second accessible destructive confirmation
  dialog naming the exact item.
- `Empty Recycle Bin` opens a destructive confirmation dialog with the exact
  item count.
- Cancel, Escape, backdrop dismissal, or closing either dialog changes
  nothing.
- Confirming permanent deletion removes only the selected archive, or the
  current account’s complete archive set for Empty Bin.
- Permanent deletion cannot affect active agents, active skills, built-in
  agents, preset skills, or another account.

### Retention and expiry

- Retention is exactly `90 * 24 * 60 * 60 * 1000` milliseconds from
  `deletedAt`.
- An item is recoverable while `now < expiresAt`.
- At `now >= expiresAt`, it is no longer returned or restorable.
- Expired records are pruned whenever the store loads, the account scope
  changes, the bin is listed, or a bin mutation occurs.
- Expiry uses the persisted absolute `expiresAt`; changing the system clock
  backward cannot extend a previously persisted deadline.

## Architecture

### Account-scoped recycle-bin store

Create `app/src/features/recycle-bin/recycleBinStore.ts`.

The store is an external observable store backed by account-scoped
`localStorage`, matching the existing custom-skill persistence boundary.
Signed-out/session-only use remains memory-only. Its storage key is versioned
and contains only validated, bounded records.

```ts
type RecycleBinKind = 'agent' | 'skill';

type RecycledAgentItem = {
  archiveId: string;
  kind: 'agent';
  entityId: AgentId;
  name: string;
  deletedAt: number;
  expiresAt: number;
  payload: Agent;
};

type RecycledSkillItem = {
  archiveId: string;
  kind: 'skill';
  entityId: string;
  name: string;
  deletedAt: number;
  expiresAt: number;
  payload: CustomSkillRecord;
};

type RecycleBinItem = RecycledAgentItem | RecycledSkillItem;
```

The store exposes:

```ts
getSnapshot(): readonly RecycleBinItem[];
subscribe(listener: () => void): () => void;
archiveAgent(agent: Agent, now?: number): RecycledAgentItem;
archiveSkill(skill: CustomSkillRecord, now?: number): RecycledSkillItem;
removeArchive(archiveId: string): void;
restoreArchive(item: RecycleBinItem): void;
empty(): void;
pruneExpired(now?: number): void;
```

`restoreArchive` means reinsert an already validated item after compensation;
it does not recreate an active entity.

Validation limits archive count, string sizes, arrays, agent fields, and skill
fields. Prototype-polluting keys and malformed payloads are discarded. Only
the active account’s storage key is loaded.

### Lifecycle service

Create `app/src/features/recycle-bin/recycleBinService.ts`.

This service connects archive persistence to existing Agent and Skill
repositories:

```ts
moveAgentToRecycleBin(agent: Agent): Promise<void>;
moveSkillToRecycleBin(skill: CustomSkillRecord): void;
restoreRecycleBinItem(item: RecycleBinItem): Promise<RestoreResult>;
permanentlyDeleteRecycleBinItem(archiveId: string): void;
emptyRecycleBin(): void;
```

It owns compensation, conflict-safe agent restoration, runtime registry
refresh, and bounded errors. UI components never directly sequence archive and
active-store mutations.

### Custom-skill store seam

Extend `skillsStore.ts` with exact-record operations:

```ts
getCustomSkill(id: string): CustomSkillRecord | undefined;
restoreCustomSkill(record: CustomSkillRecord): void;
```

Catalog persistence changes to persist the normalized next snapshot before
publishing it to Zustand. A storage write failure therefore leaves the visible
active catalog unchanged.

### Shared confirmation dialog

Create `app/src/features/recycle-bin/RecycleBinConfirmDialog.tsx`.

It wraps the existing Radix-based Dialog primitives, sets
`role="alertdialog"`, uses linked title/description, focuses Cancel on open,
and supports three intents:

- move one item to the bin;
- permanently delete one item;
- empty the current account’s bin.

The dialog owns only presentation and confirmation. The caller supplies the
bounded async action and keeps it open with a visible error if the action
fails.

### Settings surface

Create `app/src/features/recycle-bin/RecycleBinSettings.tsx` and render it from
`General.tsx`.

The component uses `useSyncExternalStore` so deletion, restoration, expiry,
and account switches update the list without polling. Dates use the user’s
locale; behavior and tests use absolute timestamps.

## Data and account isolation

- The recycle-bin storage scope uses the same active account identity
  authority as the custom-skill store.
- A scope change clears the in-memory snapshot before loading the next scope.
- No archive payload, item name, or entity ID is logged.
- Public UI error messages are bounded constants.
- The system does not synchronize recycle-bin payloads to Cloudflare,
  Supabase, or another device in this version. This is intentionally a
  device-local safety net consistent with custom-skill storage.
- Active agent deletion continues through `agentRepo.delete`, preserving its
  existing sync tombstone semantics. Restoration continues through
  `agentRepo.create`.

## Error handling

- Archive validation/storage failure: active entity remains.
- Agent/skill removal failure: archive entry is removed as compensation.
- Restore conflict: create a conflict-safe agent copy; never overwrite.
- Restore creation failure: archive remains.
- Archive-removal failure after creation: remove the recreated active entity;
  archive remains.
- Permanent-delete storage failure: dialog remains open and item remains.
- Malformed or expired persisted data: discard without rendering or logging
  the raw record.

## Accessibility and visual behavior

- Dialogs use `alertdialog` semantics, visible destructive labeling, initial
  Cancel focus, Escape support, and focus restoration.
- Decorative icons are `aria-hidden`.
- Recycle-bin rows have accessible names that include item type and name.
- Destructive actions are never encoded by color alone.
- Layout remains compact in the existing General settings width and scrolls
  inside the settings page rather than creating a nested page-level modal.
- Existing themes, including MonoChrome, use semantic surface and text tokens.

## Tests

### Store tests

- account A cannot read or mutate account B’s archives;
- a record remains through 89 days, 23 hours, 59 minutes, 59.999 seconds;
- a record disappears exactly at 90 days;
- malformed, oversized, prototype-polluting, and duplicate records are
  discarded;
- failed persistence does not publish an in-memory mutation;
- subscribers receive one update per committed mutation.

### Service tests

- agent archive precedes active deletion;
- active deletion failure removes the archive;
- skill deletion removes it from the active catalog and runtime registry;
- restore preserves complete payload and identity;
- agent ID/slug collision produces a safe restored copy;
- failed restore leaves the archive;
- compensation prevents active/archive duplication;
- permanent deletion affects only the selected archive.

### UI tests

- Agent Delete and Skill Delete open the confirmation dialog;
- Cancel, Escape, and backdrop dismissal preserve active items;
- confirm removes the item from active UI and places it in Settings;
- General lists agents and skills with remaining recovery time;
- Restore reactivates and removes the archive row;
- permanent delete and Empty Bin each require confirmation;
- built-in agents and preset skills expose no recycle-bin delete path;
- dialog naming, focus, and error states are accessible.

## Scope exclusions

- No deletion or recycle behavior for built-in agents or preset skills.
- No cloud-synchronized recycle bin.
- No recycle behavior for chats, projects, files, terminals, memories, or
  other entities.
- No database schema, backend, native, dependency, billing, authentication,
  news, benchmark, or chat changes.
