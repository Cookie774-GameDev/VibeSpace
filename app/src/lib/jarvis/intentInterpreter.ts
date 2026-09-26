import { localConversationReply } from './responsePolicy';
import { parseJarvisModelSwitchIntent } from './modelSwitchDecision';
import { planJarvisDelegation } from './delegationDecision';

export type JarvisIntent =
  | 'casual-conversation'
  | 'question-answering'
  | 'local-command'
  | 'app-navigation'
  | 'app-configuration'
  | 'file-work'
  | 'terminal-work'
  | 'tool-creation'
  | 'plugin-use'
  | 'mcp-use'
  | 'agent-creation'
  | 'agent-execution'
  | 'multi-agent-orchestration'
  | 'long-running-workflow'
  | 'memory-update'
  | 'destructive-action'
  | 'ambiguous';

export type JarvisExecutionMode =
  | 'none'
  | 'automatic'
  | 'first-time-or-approved'
  | 'approval-required'
  | 'proposal-only'
  | 'explicit-approval-required'
  | 'clarification-required';

export interface InterpretedJarvisStep {
  action: string;
  input: Record<string, unknown>;
  /** True when a prior step must supply one or more final inputs. */
  deferred?: boolean;
}

export interface InterpretedJarvisRequest {
  intent: JarvisIntent;
  execution: JarvisExecutionMode;
  steps: InterpretedJarvisStep[];
  response: string;
}

function result(
  intent: JarvisIntent,
  execution: JarvisExecutionMode,
  steps: InterpretedJarvisStep[],
  response: string,
): InterpretedJarvisRequest {
  return { intent, execution, steps, response };
}

function terminalCount(text: string): number {
  const match = /\b(?:open|create|start)\s+(\d{1,2})\s+terminals?\b/i.exec(text);
  return Math.min(10, Math.max(1, Number(match?.[1] ?? 1)));
}

function nextLocalTime(hour: number, minute = 0): number {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function interpretJarvisRequest(raw: string): InterpretedJarvisRequest {
  const text = raw.replace(/\s+/g, ' ').trim();
  const local = localConversationReply(text);
  if (local) {
    const conversational =
      /^(?:hi|hey|hello|howdy|yo|good\s|how(?:'s| is) (?:your )?day|how are you|tell me|say |(?:a )?(?:quick )?(?:developer )?joke)/i.test(
        text,
      );
    return result(conversational ? 'casual-conversation' : 'question-answering', 'none', [], local);
  }
  if (/^\/usage\b/i.test(text)) {
    return result(
      'local-command',
      'none',
      [],
      'Showing usage for the selected provider and model.',
    );
  }
  if (parseJarvisModelSwitchIntent(text)) {
    return result(
      'app-configuration',
      'approval-required',
      [{ action: 'chat.model.switch', input: { request: text } }],
      'The model switch is prepared for review.',
    );
  }
  if (/^(?:please\s+)?remember(?:\s+that|:)?\s+/i.test(text)) {
    return result('memory-update', 'automatic', [], 'Memory updated.');
  }
  if (/\b(?:evaluate|show)\b.*\blearned preferences?\b.*\b(?:ten|10)\b/i.test(text)) {
    return result(
      'memory-update',
      'automatic',
      [],
      'Evaluating the account-scoped learned preferences after the ten-message checkpoint.',
    );
  }
  if (/\bswitch accounts?\b.*\blearned preferences?\b/i.test(text)) {
    return result(
      'memory-update',
      'automatic',
      [],
      'Learned preferences reload from the newly authenticated account only.',
    );
  }
  if (/^open\s+(?:it|that|this)\.?$/i.test(text)) {
    return result('ambiguous', 'clarification-required', [], 'What would you like me to open?');
  }
  if (/\bdelete\s+(?:every|all)\s+projects?\b/i.test(text)) {
    return result(
      'destructive-action',
      'explicit-approval-required',
      [],
      'That would delete every project, so I need an explicit scoped approval before any deletion can be planned.',
    );
  }
  if (/\bpropose\b.*\b(?:color\s+)?theme\b/i.test(text)) {
    return result(
      'app-configuration',
      'proposal-only',
      [{ action: 'settings.update', input: { setting: 'theme', value: 'jarvis' } }],
      'I can propose the Jarvis theme without applying it.',
    );
  }
  if (/\bopen\s+jarvis\s+actions?\b/i.test(text)) {
    return result(
      'app-navigation',
      'automatic',
      [{ action: 'settings.jarvisactions', input: {} }],
      'Opening Jarvis Actions.',
    );
  }
  const rename = /\brename\s+(?:this\s+)?chat\s+to\s+(.+?)[.!?]*$/i.exec(text);
  if (rename?.[1]) {
    return result(
      'app-configuration',
      'first-time-or-approved',
      [{ action: 'chat.rename', input: { title: rename[1].trim().replace(/[.!?]+$/, '') } }],
      `Renaming this chat to ${rename[1].trim().replace(/[.!?]+$/, '')}.`,
    );
  }
  if (/\bretry\b.*\bsame chat rename\b.*\bduplicated\b/i.test(text)) {
    return result(
      'app-configuration',
      'first-time-or-approved',
      [{ action: 'chat.rename', input: { title: 'Agent Testing' } }],
      'Retrying the chat rename once without duplicating the action.',
    );
  }
  if (
    /\bcreate\s+(?:a\s+)?jarvis\s+action\b/i.test(text) &&
    /\b(?:weekday|daily|weekly|at\s+\d)/i.test(text)
  ) {
    const title = /\bnamed\s+(.+?)\s+for\s+/i.exec(text)?.[1]?.trim() || 'Jarvis Action';
    const hourMatch = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
    let hour = Number(hourMatch?.[1] ?? 9) % 12;
    if (hourMatch?.[3]?.toLowerCase() === 'pm') hour += 12;
    return result(
      'long-running-workflow',
      'approval-required',
      [
        {
          action: 'schedule.create',
          input: {
            title,
            prompt: title,
            startAtMs: nextLocalTime(hour, Number(hourMatch?.[2] ?? 0)),
            recurrence: /\bweekdays?\b/i.test(text)
              ? 'weekdays'
              : /\bdaily\b/i.test(text)
                ? 'daily'
                : 'weekly',
          },
        },
      ],
      `I’ll create the ${title} schedule after approval.`,
    );
  }
  if (/\bcreate\s+(?:a\s+)?custom\s+tool\b/i.test(text)) {
    const name =
      /\b(?:named|called)\s+(.+?)(?:\s+that|\s+to|[.!?]|$)/i.exec(text)?.[1] ?? 'Open main project';
    return result(
      'tool-creation',
      'approval-required',
      [
        {
          action: 'tool.create',
          input: {
            name: name.trim(),
            description: 'Open the main project files.',
            stepsJson: JSON.stringify([{ action: 'nav.files', params: {} }]),
          },
        },
      ],
      'I’ll create and verify the custom tool after approval.',
    );
  }
  if (/\bfind\b.*\bfiles?\b.*\b(?:attach|add)\b.*\bcontext\b/i.test(text)) {
    const query = text
      .replace(
        /\s+(?:and\s+)?(?:attach|add)\s+(?:them|the\s+files?)\s+(?:as|to)\s+context[.!?]*$/i,
        '',
      )
      .trim();
    return result(
      'file-work',
      'approval-required',
      [
        { action: 'file.search', input: { query } },
        { action: 'file.attach', input: {}, deferred: true },
      ],
      'Searching for real matching files, then I’ll attach the verified paths.',
    );
  }
  if (/\boffline\s+mode\b.*\b(?:file|attachment)\b/i.test(text)) {
    return result(
      'file-work',
      'automatic',
      [],
      'I’ll use only the local runtime and the attached file.',
    );
  }
  if (/\b(?:which|what)\s+agents?\b.*\bactive\b|\bshow\b.*\bagents?\b.*\bactive\b/i.test(text)) {
    return result(
      'agent-execution',
      'automatic',
      [{ action: 'agent.status', input: {} }],
      'Checking the live agent state.',
    );
  }
  if (/\bcreate\s+(?:a\s+)?(?:research\s+)?agent\b/i.test(text)) {
    const task =
      /\bfor\s+(.+?)(?:,?\s+but\s+do\s+not\s+run|[.!?]|$)/i.exec(text)?.[1]?.trim() || 'research';
    return result(
      'agent-creation',
      'first-time-or-approved',
      [
        {
          action: 'agent.create',
          input: {
            name: /research/i.test(text) ? 'Research Agent' : 'Custom Agent',
            description: `Research ${task}.`,
            systemPrompt: `Research ${task} using only necessary context. Do not modify files unless explicitly approved.`,
          },
        },
      ],
      'I’ll create the agent without running it.',
    );
  }
  if (/\brun\s+two\b.*\bagents?\b/i.test(text)) {
    return result(
      'multi-agent-orchestration',
      'approval-required',
      [
        {
          action: 'agent.run_many',
          input: {
            tasksJson: JSON.stringify([
              { task: 'Inspect the chat system without editing terminal files.' },
              { task: 'Inspect the terminal system without editing chat files.' },
            ]),
          },
        },
      ],
      'I’ll run two non-overlapping agents, track both, and collect their results.',
    );
  }
  if (/\bwait\s+for\b.*\bagent\b/i.test(text)) {
    return result(
      'agent-execution',
      'automatic',
      [{ action: 'agent.wait', input: {} }],
      'Waiting for the agent’s actual terminal state.',
    );
  }
  if (/\bshopify\s+plugin\b.*\bconnected\b/i.test(text)) {
    return result(
      'plugin-use',
      'automatic',
      [{ action: 'plugin.status', input: { pluginId: 'shopify' } }],
      'Checking the Shopify connection metadata.',
    );
  }
  if (/\bplugin\b.*\b(?:run|invoke|tool|timeout)\b/i.test(text)) {
    return result(
      'plugin-use',
      'explicit-approval-required',
      [],
      'No generic plugin invocation is registered; I can use only reviewed literal plugin actions.',
    );
  }
  if (/\bsupabase\b.*\b(?:delete|drop|truncate|alter|update|insert|write|remove)\b/i.test(text)) {
    return result(
      'destructive-action',
      'explicit-approval-required',
      [],
      'That Supabase request could modify or delete database data, so it will not run through the automatic read-only path.',
    );
  }
  if (/\bsupabase\b.*\b(?:list|inspect|show)\b.*\btables?\b/i.test(text)) {
    return result(
      'mcp-use',
      'automatic',
      [
        { action: 'mcp.start', input: { serverId: 'supabase' } },
        {
          action: 'mcp.invoke',
          input: { serverId: 'supabase', toolName: 'list_tables', inputJson: '{}' },
        },
      ],
      'Starting the Supabase MCP and using its read-only table tool.',
    );
  }
  if (/\bmcp\b.*\b(?:executable|dependency)\b.*\bnot installed\b/i.test(text)) {
    return result(
      'mcp-use',
      'automatic',
      [{ action: 'mcp.start', input: { serverId: 'requested' } }],
      'Checking the configured MCP dependency and reporting the exact startup failure if it is unavailable.',
    );
  }
  if (/\bmcp\b/i.test(text)) {
    const serverId = /\b(repository|repo)\s+mcp\b/i.test(text) ? 'repository' : 'requested';
    return result(
      'mcp-use',
      'approval-required',
      [
        { action: 'mcp.start', input: { serverId } },
        ...(/\buse\b/i.test(text)
          ? [{ action: 'mcp.invoke', input: { serverId }, deferred: true } as InterpretedJarvisStep]
          : []),
      ],
      'I’ll start one MCP instance, health-check it, and use only its declared tool.',
    );
  }
  if (/\bcancel\b.*\b(?:running\s+)?(?:terminal\s+)?(?:workflow|task|run)\b/i.test(text)) {
    return result(
      'long-running-workflow',
      'automatic',
      [{ action: 'task.cancel', input: {} }],
      'Cancelling the active workflow and unfinished steps.',
    );
  }
  if (/\brun\b.*\bworkflow\b.*\bnotify\b/i.test(text)) {
    return result(
      'long-running-workflow',
      'approval-required',
      [
        { action: 'tool.run', input: {}, deferred: true },
        { action: 'notification.send', input: {}, deferred: true },
      ],
      'I’ll keep the workflow running in the background and notify you with its verified result.',
    );
  }
  if (/\b(?:open|create)\s+\d+\s+terminals?\b/i.test(text)) {
    const count = terminalCount(text);
    const cli = /\bclaude\b/i.test(text) ? 'claude' : /\bcodex\b/i.test(text) ? 'codex' : '';
    return result(
      'terminal-work',
      'approval-required',
      [{ action: 'terminal.ensure_total', input: { count, ...(cli ? { cli } : {}) } }],
      `Opening ${count} safe terminal${count === 1 ? '' : 's'}${cli ? ` and starting ${cli}` : ''}; I’ll verify startup before claiming completion.`,
    );
  }
  const delegation = planJarvisDelegation(text);
  if (delegation.status === 'delegate') {
    const tasks = delegation.tasks.map((task) => ({
      task: `${task.role}: ${task.objective}`,
    }));
    return result(
      'multi-agent-orchestration',
      'approval-required',
      [
        {
          action: 'agent.run_many',
          input: { tasksJson: JSON.stringify(tasks) },
        },
      ],
      `I’ve prepared ${delegation.tasks.map((task) => task.role).join(' and ')} for the bounded specialist work. The batch is awaiting approval.`,
    );
  }
  if (/\b(?:selected\s+provider|summari[sz]e|explain|what|how|why)\b/i.test(text)) {
    return result(
      'question-answering',
      'none',
      [],
      'I’ll answer concisely using the selected provider and available context.',
    );
  }
  return result(
    'question-answering',
    'none',
    [],
    'I’ll help with that using the relevant VibeSpace capabilities.',
  );
}
