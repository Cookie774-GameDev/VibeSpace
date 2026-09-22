import { applySecretPolicy } from '@/lib/security/secretDetector';
import type { ChatActivityCategory, ChatActivityStatus } from '@/features/chat/activity/types';

export interface OpenCodeLiveToolActivityInput {
  name: string;
  status: 'started' | 'completed' | 'failed';
  fileLabel?: string;
}

type ActivitySemantic = 'read' | 'search' | 'command' | 'edit' | 'check' | 'task' | 'browser' | 'tool';

export interface OpenCodeLiveToolActivityProjection {
  event: Readonly<{
    category: ChatActivityCategory;
    status: ChatActivityStatus;
    title: string;
    subtitle: string;
    filePath?: string;
  }>;
  phase: Readonly<{
    category: ChatActivityCategory;
    title: string;
    subtitle?: string;
  }>;
}

const COMMAND_TOOL = /(?:^|[._:/-])(shell|terminal|command|exec|powershell|bash)(?:$|[._:/-])/iu;
const READ_TOOL = /(?:^|[._:/-])(read|open|get_file|file_read)(?:$|[._:/-])/iu;
const SEARCH_TOOL = /(?:^|[._:/-])(search|find|grep|glob|query|vibespace_context)(?:$|[._:/-])/iu;
const EDIT_TOOL = /(?:^|[._:/-])(edit|write|patch|apply_patch|replace)(?:$|[._:/-])/iu;
const CHECK_TOOL = /(?:^|[._:/-])(test|verify|check|lint|build)(?:$|[._:/-])/iu;
const BROWSER_TOOL = /(?:^|[._:/-])(?:browser|playwright)(?:$|[._:/-])/iu;
const SAFE_PUBLIC_LABEL = /^[^\u0000-\u001f\u007f]{1,256}$/u;

function semantic(name: string): ActivitySemantic {
  if (name === 'task') return 'task';
  if (BROWSER_TOOL.test(name)) return 'browser';
  if (COMMAND_TOOL.test(name)) return 'command';
  if (READ_TOOL.test(name)) return 'read';
  if (SEARCH_TOOL.test(name)) return 'search';
  if (EDIT_TOOL.test(name)) return 'edit';
  if (CHECK_TOOL.test(name)) return 'check';
  return 'tool';
}

function safeToolName(value: string): string {
  const name = value.trim();
  if (!SAFE_PUBLIC_LABEL.test(name)) throw new Error('opencode_live_tool_name_invalid');
  return name;
}

function safeLeaf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').trim();
  const relative = !/^(?:[a-z]:|\/)/i.test(normalized) && !normalized.split('/').includes('..');
  const leaf = relative ? normalized.replace(/^\.\//, '') : normalized.split('/').filter(Boolean).at(-1)?.trim();
  if (!leaf || !SAFE_PUBLIC_LABEL.test(leaf)) return undefined;
  const redacted = applySecretPolicy(leaf, 'redact').text?.trim();
  return redacted && SAFE_PUBLIC_LABEL.test(redacted) ? redacted : undefined;
}

function categoryFor(kind: ActivitySemantic): ChatActivityCategory {
  if (kind === 'task') return 'coordination';
  if (kind === 'read') return 'file';
  if (kind === 'edit') return 'writing';
  return 'context';
}

const TITLES: Readonly<
  Record<
    ActivitySemantic,
    Readonly<Record<OpenCodeLiveToolActivityInput['status'], readonly [string, string]>>
  >
> = Object.freeze({
  read: {
    started: ['Reading file', 'Jarvis is reading file'],
    completed: ['Read file', 'Jarvis read file'],
    failed: ['File read failed', 'Jarvis file read failed'],
  },
  search: {
    started: ['Searching', 'Jarvis is searching'],
    completed: ['Searched', 'Jarvis searched'],
    failed: ['Search failed', 'Jarvis search failed'],
  },
  command: {
    started: ['Running command', 'Jarvis is running command'],
    completed: ['Ran command', 'Jarvis ran command'],
    failed: ['Command failed', 'Jarvis command failed'],
  },
  edit: {
    started: ['Editing file', 'Jarvis is editing file'],
    completed: ['Edited file', 'Jarvis edited file'],
    failed: ['Edit failed', 'Jarvis edit failed'],
  },
  check: {
    started: ['Verifying', 'Jarvis is verifying'],
    completed: ['Verified', 'Jarvis verified'],
    failed: ['Verification failed', 'Jarvis verification failed'],
  },
  task: {
    started: ['Coordinating agents', 'Jarvis is coordinating agents'],
    completed: ['Coordinated agents', 'Jarvis coordinated agents'],
    failed: ['Agent task failed', 'Jarvis agent task failed'],
  },
  tool: {
    started: ['Running tool', 'Jarvis is running a tool'],
    completed: ['Ran tool', 'Jarvis ran a tool'],
    failed: ['Tool failed', 'Jarvis tool failed'],
  },
  browser: {
    started: ['Using browser', 'Jarvis is using browser'],
    completed: ['Used browser', 'Jarvis used browser'],
    failed: ['Browser tool failed', 'Jarvis browser tool failed'],
  },
});

export function projectOpenCodeLiveToolActivity(
  input: Readonly<OpenCodeLiveToolActivityInput>,
): Readonly<OpenCodeLiveToolActivityProjection> {
  const name = safeToolName(input.name);
  const kind = semantic(name);
  const category = categoryFor(kind);
  const filePath = safeLeaf(input.fileLabel);
  const [eventTitle, phaseTitle] = TITLES[kind][input.status];
  const status: ChatActivityStatus =
    input.status === 'started' ? 'running' : input.status === 'completed' ? 'done' : 'error';
  return Object.freeze({
    event: Object.freeze({
      category,
      status,
      title: eventTitle,
      subtitle: filePath ?? name,
      ...(filePath ? { filePath } : {}),
    }),
    phase: Object.freeze({
      category,
      title: phaseTitle,
      ...(filePath ? { subtitle: filePath } : {}),
    }),
  });
}
