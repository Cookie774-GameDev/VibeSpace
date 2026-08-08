# Hive product gate (scrapped surface)

**Status:** Hive is **gated off** in the active product. Implementation modules remain for recovery; users must not reach unfinished Hive UI through navigation, search, command palette, onboarding, settings, slash commands, or stale deep links.

## What is gated

| Surface | Behavior when gated (default) |
|---------|--------------------------------|
| Settings → Hive tab | Hidden from nav; `jarvis:settings:tab` / `initialTab: 'hive'` resolve to settings root (`plans`) |
| Composer model picker Hive row | Not shown (`onSelectHive` omitted) |
| `/hive` slash command | Removed from typeahead and command resolution |
| StackPicker | Renders nothing |
| Persisted `chatModelSelection.mode === 'hive'` | Neutralized to empty/single-model path on load and set |
| Runtime multi-model stack (`runStack`) | `resolveActiveStackPreset` forces `off` |
| Jarvis “Use Hive Balanced” model switch | Fails closed as not configured |

## Where the code remains

| Area | Paths |
|------|--------|
| Settings page UI | `app/src/features/settings/sections/Hive.tsx` |
| Brand mark | `app/src/components/brand/HiveModelIcon.tsx`, `app/public/hive-model-icon.png` |
| Stack engine | `app/src/lib/ai/stacks/*` (`runner.ts`, `hiveFinalizer.ts`, `hiveWorkerExecutor.ts`, presets, classifier) |
| Model selection types | `app/src/lib/ai/modelSelection.ts` (`mode: 'hive'`) |
| Auth persistence fields | `app/src/stores/auth.ts` (`stackPreset`, `stackCustomSteps`, `chatModelSelection`) |
| Spec docs | `docs/HIVE.md`, `docs/VIBE_HIVE.md`, `docs/HIVE_PIPELINE_SIMULATION_TIERS.md` |

## Gate implementation

- **Flag module:** `app/src/lib/features/hiveProductGate.ts`
- **Env flag:** `VITE_HIVE_ENABLED` (see `app/src/vite-env.d.ts`)
- **Default:** disabled (`false` / unset / any non-truthy value)

Truthy values: `true`, `1`, `yes`, `on` (case-insensitive, trimmed).

## How to re-enable (recovery)

1. Set in `app/.env.local` (or the shell that launches Vite):

   ```bash
   VITE_HIVE_ENABLED=true
   ```

2. Restart the Vite / Tauri dev process so `import.meta.env` is rebuilt.

3. Confirm:
   - Settings left rail shows **Hive**
   - Composer model picker shows the Hive entry
   - `/hive` appears in slash typeahead
   - Deep link / event `jarvis:settings:tab` with `{ tab: 'hive' }` opens the Hive panel

4. Optional: restore monochrome capture of `settings:hive` as a normal production surface once product ownership resumes (manifest currently marks it `feature-flagged`).

## What not to do

- Do not delete stack/Hive modules to “finish” the gate — recovery depends on them.
- Do not redesign or revive Hive UX in a gate-only change.
- Do not re-introduce Hive into command-palette settings actions unless the flag is on and product owns the surface again.
