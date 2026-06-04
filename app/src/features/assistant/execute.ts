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
 *   - Terminal intents are routed into the live terminal command queue so
 *     they spawn real PTYs or write into existing panes.
 */
import {
  chatRepo,
  eventRepo,
  projectRepo,
  taskRepo,
} from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { parseEventInput } from '@/features/schedule/parseEventInput';
import { broadcastTerminalCommand, enqueueTerminalCommand } from '@/features/terminals/terminalCommandQueue';
import { fireOutboundCall, sendOutboundMessage } from '@/features/call/outbound';
import { formatContextTreeForPrompt, loadStoredContextTree } from '@/features/context/tree';
import { useToolStore, slugify } from '@/features/tools/toolStore';
import { runAction } from '@/lib/actions';
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
        if (projectId) useAuthStore.getState().setProjectId(projectId);
        for (let i = 0; i < count; i++) {
          enqueueTerminalCommand({
            command,
            label: count === 1 ? titleBase : `${titleBase} ${i + 1}`,
          });
        }
        useUIStore.getState().setRoute('terminal');
        const verb = count === 1 ? 'terminal' : 'terminals';
        const cmdNote = command ? ` running ${command}` : '';
        const projNote = intent.project ? ` in '${intent.project}'` : '';
        return ok(`Opened ${count} ${verb}${cmdNote}${projNote}.`);
      }

      // ----------------------------------------------------------------
      case 'run_in_terminals': {
        const command = intent.command.trim();
        if (!command) return fail('Tell me which command to run.');
        broadcastTerminalCommand({ command, label: command });
        useUIStore.getState().setRoute('terminal');
        return ok(`Running '${command}' in all terminal panes.`);
      }

      // ----------------------------------------------------------------
      case 'create_custom_command': {
        const name = intent.name.trim();
        const command = intent.command.trim();
        if (!name || !command) return fail('Custom commands need a name and a command to run.');
        const tool = useToolStore.getState().create({
          name,
          description: `Run ${command} in a new terminal pane.`,
          baseAction: 'terminal.run',
          params: {
            command,
            label: name,
            ...(intent.cwd ? { cwd: intent.cwd } : {}),
          },
        });
        return ok(`Created command '${name}' as custom.${tool.slug}.`);
      }

      // ----------------------------------------------------------------
      case 'run_custom_command': {
        const name = intent.name.trim();
        if (!name) return fail('Tell me which custom command to run.');
        const tools = useToolStore.getState().list();
        const normalized = name.toLowerCase();
        const slug = slugify(name);
        const tool =
          tools.find((item) => item.slug === slug) ??
          tools.find((item) => item.name.trim().toLowerCase() === normalized) ??
          tools.find((item) => item.name.trim().toLowerCase().includes(normalized));
        if (!tool) return fail(`No custom command named '${name}'. Create it first.`);
        const result = await runAction(`custom.${tool.slug}`, {}, { source: 'user' }, { emitToast: false });
        if (!result.ok) return fail(result.error);
        return ok(result.summary ?? `Ran '${tool.name}'.`);
      }

      // ----------------------------------------------------------------
      case 'clock_timer': {
        const result = await runAction(
          'clock.timer',
          {
            durationMinutes: intent.durationMinutes,
            durationSeconds: intent.durationSeconds ?? 0,
            label: intent.label ?? 'Timer',
          },
          { source: 'user' },
          { emitToast: false },
        );
        if (!result.ok) return fail(result.error);
        return ok(result.summary ?? 'Timer set.');
      }

      // ----------------------------------------------------------------
      case 'clock_alarm': {
        const result = await runAction(
          'clock.alarm',
          {
            time: intent.time,
            label: intent.label ?? 'Alarm',
          },
          { source: 'user' },
          { emitToast: false },
        );
        if (!result.ok) return fail(result.error);
        return ok(result.summary ?? 'Alarm set.');
      }

      // ----------------------------------------------------------------
      case 'ask_provider': {
        const provider = intent.provider.toLowerCase();
        const prompt = intent.prompt.trim();
        if (!prompt) return fail('Tell me what to ask.');
        const command = `${provider} ${JSON.stringify(prompt)}`;
        enqueueTerminalCommand({ command, label: provider });
        useUIStore.getState().setRoute('terminal');
        return ok(`Queued ${provider} with your request.`);
      }

      // ----------------------------------------------------------------
      case 'give_terminals_context': {
        const projectId = useAuthStore.getState().projectId;
        const contextParts: string[] = [];
        if (projectId) {
          const project = await projectRepo.getById(projectId);
          if (project?.system_prompt_context?.trim()) contextParts.push(project.system_prompt_context.trim());
        }
        const tree = loadStoredContextTree(projectId);
        if (tree) contextParts.push(formatContextTreeForPrompt(tree));
        const context = contextParts.join('\n\n') || 'Jarvis project context is active for this workspace.';
        const command = context.split('\n').map((line) => (line ? `# ${line}` : '#')).join('\n');
        broadcastTerminalCommand({
          command,
          label: 'context',
        });
        useUIStore.getState().setRoute('terminal');
        return ok('Sent project context to every terminal pane.');
      }

      // ----------------------------------------------------------------
      case 'create_context_map': {
        useUIStore.getState().setRoute('context');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('jarvis:context:create-map'));
        }, 0);
        return ok('Creating the project Context map.');
      }

      // ----------------------------------------------------------------
      case 'recenter_context_map': {
        useUIStore.getState().setRoute('context');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('jarvis:context:recenter-map'));
        }, 0);
        return ok('Centered the project Context map.');
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
      case 'schedule_call': {
        const workspaceId = getWorkspaceId();
        if (!workspaceId) return fail('No active workspace yet.');
        const parsed = parseEventInput(intent.raw);
        await eventRepo.create({
          workspace_id: workspaceId,
          title: parsed.title || 'Jarvis call',
          start_at: parsed.start_at,
          end_at: parsed.end_at,
          all_day: false,
          reminders: [{ offset_min: 0, channels: ['desktop', 'in_app'] }],
          source: 'ai',
          created_by: useAuthStore.getState().localUserId ?? 'usr_local',
        });
        const delay = parsed.start_at - Date.now();
        const callContext = {
          title: parsed.title || 'Scheduled Jarvis call',
          details: `User requested a Jarvis call for ${new Date(parsed.start_at).toLocaleString()}.`,
          scheduled_for: parsed.start_at,
        };
        if (delay <= 30_000) {
          fireOutboundCall('manual', callContext);
        } else if (typeof window !== 'undefined') {
          window.setTimeout(() => fireOutboundCall('manual', callContext), delay);
        }
        return ok(`Scheduled Jarvis to call you at ${new Date(parsed.start_at).toLocaleString()}.`);
      }

      // ----------------------------------------------------------------
      case 'send_phone_message': {
        const result = await sendOutboundMessage(intent.text, 'manual', {
          title: 'Jarvis message',
        });
        if (!result.ok) return fail(result.error);
        return ok('Sent the message to your phone number.');
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
        useUIStore.getState().setRoute('schedule');
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
      case 'multi_step': {
        const messages: string[] = [];
        for (let i = 0; i < intent.steps.length; i += 1) {
          const step = intent.steps[i]!;
          const result = await executeIntent(step);
          if (!result.ok) {
            return fail(`Step ${i + 1} failed: ${result.message}`);
          }
          messages.push(result.message);
        }
        return ok(messages.join(' '));
      }

      // ----------------------------------------------------------------
      case 'unknown':
      default: {
        const suggestions = ('suggestions' in intent ? (intent as { suggestions?: string[] }).suggestions : undefined) ?? [];
        const hint = suggestions.length > 0
          ? ` Did you mean: ${suggestions.slice(0, 3).map((s) => `"${s}"`).join(', ')}?`
          : '';
        return fail(
          `I didn't catch that. Try: 'create project tiger then open 4 terminals', 'create command dev server to run npm run dev', 'call me at 3pm', or 'message me: build is done'.${hint}`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    return fail(message);
  }
}
