/**
 * Jarvis Assistant — intent executor.
 *
 * Dispatches a parsed `AssistantIntent` to the right repo / store action
 * and returns a user-friendly result envelope. Never throws — every branch
 * is wrapped in try/catch so the UI can render failures inline.
 *
 * Notes for maintainers:
 *   - All work is local. No remote AI calls.
 *   - Project name resolution is case-insensitive and trims whitespace.
 *     If a name doesn't match anything, we surface a helpful nudge.
 *   - Terminal sessions are queued as DB rows only. The PTY runtime is
 *     wired in a later milestone; the assistant just lays the data layer
 *     groundwork so users can start practising the verbs.
 */
import {
  chatRepo,
  eventRepo,
  projectRepo,
  taskRepo,
  terminalSessionRepo,
} from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { parseEventInput } from '@/features/schedule/parseEventInput';
import type { AgentId, ProjectId, WorkspaceId } from '@/types/common';
import type { AssistantIntent, AssistantResult } from './intents';

/** Cap on bulk operations from a single command. Keeps "open 4 terminals"
 * from accidentally becoming "open 9999 terminals" if a user fat-fingers. */
const MAX_BULK_TERMINALS = 10;

/** Human-friendly error wrapper. */
function fail(message: string): AssistantResult {
  return { ok: false, message };
}

/** Convenience for success messages. */
function ok(message: string): AssistantResult {
  return { ok: true, message };
}

/** Pull `workspaceId` from the auth store, returning null if missing. */
function getWorkspaceId(): WorkspaceId | null {
  return useAuthStore.getState().workspaceId;
}

/**
 * Resolve a free-form project name to a row in the current workspace.
 * Case-insensitive, whitespace-trimmed match. Falls back to substring
 * match so "tiger" matches "Tiger Eye" without the user typing the full
 * name. Returns null if no project matches.
 */
async function resolveProject(rawName: string): Promise<ProjectId | null> {
  const workspaceId = getWorkspaceId();
  if (!workspaceId) return null;
  const target = rawName.trim().toLowerCase();
  if (!target) return null;
  const all = await projectRepo.listByWorkspace(workspaceId);
  const exact = all.find((p) => p.name.trim().toLowerCase() === target);
  if (exact) return exact.id;
  const partial = all.find((p) => p.name.trim().toLowerCase().includes(target));
  return partial?.id ?? null;
}

/**
 * Hash a project name to a stable HSL hue 0..359. Mirrors the parser's
 * `hueFromName` but kept here so executor branches stay self-contained.
 */
function hueFromName(name: string): number {
  return name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
}

/**
 * Run a single parsed intent against the live app state.
 *
 * Always resolves; the result envelope tells the caller whether to
 * close the bar (ok=true) or keep it open with a warning (ok=false).
 */
export async function executeIntent(intent: AssistantIntent): Promise<AssistantResult> {
  try {
    switch (intent.kind) {
      // ----------------------------------------------------------------
      case 'create_project': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet. Finish onboarding first.');
        const name = intent.name.trim();
        if (!name) return fail('Project needs a name.');
        const project = await projectRepo.create({
          workspace_id: workspaceId,
          name,
          color_hue: intent.color_hue ?? hueFromName(name),
        });
        useAuthStore.getState().setProjectId(project.id);
        return ok(`Created project '${name}' and switched to it.`);
      }

      // ----------------------------------------------------------------
      case 'switch_project': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        const target = intent.name.trim();
        if (!target) return fail('Tell me which project to switch to.');
        const all = await projectRepo.listByWorkspace(workspaceId);
        const exact = all.find((p) => p.name.trim().toLowerCase() === target.toLowerCase());
        const matched = exact ?? all.find((p) => p.name.trim().toLowerCase().includes(target.toLowerCase()));
        if (!matched) {
          return fail(`No project named '${target}'. Tip: try 'create project ${target}' first.`);
        }
        useAuthStore.getState().setProjectId(matched.id);
        return ok(`Switched to project '${matched.name}'.`);
      }

      // ----------------------------------------------------------------
      case 'create_chat': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        let projectId: ProjectId | undefined;
        if (intent.project) {
          const resolved = await resolveProject(intent.project);
          if (!resolved) {
            return fail(`No project named '${intent.project}'. Create it first.`);
          }
          projectId = resolved;
        } else {
          // Fall back to the active project when one is selected.
          projectId = useAuthStore.getState().projectId ?? undefined;
        }
        const title = intent.title?.trim() || 'New chat';
        const chat = await chatRepo.create({
          workspace_id: workspaceId,
          project_id: projectId,
          title,
          mode: 'chat',
          active_agent_ids: [] as AgentId[],
        });
        useUIStore.getState().setActiveChat(chat.id);
        const where = intent.project ? ` in '${intent.project}'` : '';
        return ok(`Created chat '${title}'${where}.`);
      }

      // ----------------------------------------------------------------
      case 'open_terminals': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        const count = Math.min(Math.max(1, intent.count), MAX_BULK_TERMINALS);
        let projectId: ProjectId | undefined;
        if (intent.project) {
          const resolved = await resolveProject(intent.project);
          if (!resolved) {
            return fail(`No project named '${intent.project}'. Create it first.`);
          }
          projectId = resolved;
        } else {
          projectId = useAuthStore.getState().projectId ?? undefined;
        }
        // Empty command falls back to the user's default shell label so
        // the row has a non-empty title in the eventual terminal panel.
        const command = intent.command?.trim() || '';
        const titleBase = command || 'shell';
        for (let i = 0; i < count; i++) {
          await terminalSessionRepo.create({
            workspace_id: workspaceId,
            project_id: projectId,
            title: count === 1 ? titleBase : `${titleBase} ${i + 1}`,
            shell_command: command,
            // Status defaults to 'running' inside the repo; we don't have
            // a real PTY yet so 'detached' tells the future runtime "this
            // hasn't been attached anywhere".
            status: 'detached',
          });
        }
        const verb = count === 1 ? 'terminal' : 'terminals';
        const cmdNote = command ? ` running ${command}` : '';
        const projNote = intent.project ? ` in '${intent.project}'` : '';
        return ok(
          `Queued ${count} ${verb}${cmdNote}${projNote}. The terminal panel will pick these up once it ships.`,
        );
      }

      // ----------------------------------------------------------------
      case 'create_task': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        const title = intent.title.trim();
        if (!title) return fail('Tasks need a title.');
        await taskRepo.create({
          workspace_id: workspaceId,
          project_id: useAuthStore.getState().projectId ?? undefined,
          title,
          status: 'open',
          priority: 'normal',
          due_at: intent.due_at,
          created_by: 'user_text',
        });
        const dueNote = intent.due_at
          ? ` (due ${new Date(intent.due_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })})`
          : '';
        return ok(`Added task '${title}'${dueNote}.`);
      }

      // ----------------------------------------------------------------
      case 'create_event': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        const parsed = parseEventInput(intent.raw);
        if (!parsed.title) return fail("Couldn't read that event. Try 'lunch friday at 1pm'.");
        await eventRepo.create({
          workspace_id: workspaceId,
          title: parsed.title,
          start_at: parsed.start_at,
          end_at: parsed.end_at,
          all_day: parsed.all_day,
          source: 'ai',
          created_by: useAuthStore.getState().localUserId ?? 'usr_local',
        });
        const when = new Date(parsed.start_at).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: parsed.all_day ? undefined : 'numeric',
          minute: parsed.all_day ? undefined : '2-digit',
        });
        return ok(`Scheduled '${parsed.title}' for ${when}.`);
      }

      // ----------------------------------------------------------------
      case 'set_ambient': {
        useUIStore.getState().setAmbientActive(intent.on);
        return ok(intent.on ? 'Ambient mode on.' : 'Ambient mode off.');
      }

      // ----------------------------------------------------------------
      case 'set_fullscreen': {
        const ui = useUIStore.getState();
        if (intent.on === undefined) {
          ui.toggleChatFullscreen();
          return ok(useUIStore.getState().chatFullscreen ? 'Entered fullscreen.' : 'Exited fullscreen.');
        }
        if (ui.chatFullscreen !== intent.on) {
          ui.setChatFullscreen(intent.on);
        }
        return ok(intent.on ? 'Entered fullscreen.' : 'Exited fullscreen.');
      }

      // ----------------------------------------------------------------
      case 'open_settings': {
        useUIStore.getState().setSettingsOpen(true);
        return ok('Opened settings.');
      }
      case 'open_palette': {
        useUIStore.getState().setPaletteOpen(true);
        return ok('Opened command palette.');
      }
      case 'open_launcher': {
        useUIStore.getState().setLauncherOpen(true);
        return ok('Opened quick launcher.');
      }
      case 'open_schedule': {
        useUIStore.getState().setScheduleOpen(true);
        return ok('Opened schedule.');
      }

      // ----------------------------------------------------------------
      // V3 top-level route navigation. `setRoute` is added to `useUIStore`
      // by the route-store slice (Wave 4 cross-slice contract). If that
      // slice hasn't landed yet this case will tsc-error — the integrator
      // is expected to reconcile.
      case 'navigate': {
        useUIStore.getState().setRoute(intent.route);
        return ok(`Showing ${intent.route}.`);
      }

      // ----------------------------------------------------------------
      case 'unknown':
      default: {
        return fail(
          "I didn't catch that. Try: 'create project tiger', 'open 4 terminals', 'fullscreen'.",
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    return fail(message);
  }
}
