import type { SlashCommandOption } from './SlashCommandOptionPicker';

export type MarkdownDocumentKind =
  | 'goal'
  | 'agent'
  | 'skill'
  | 'prompt'
  | 'design'
  | 'test'
  | 'policy'
  | 'context'
  | 'custom';

export const MARKDOWN_DOCUMENT_OPTIONS: readonly SlashCommandOption[] = [
  {
    id: 'goal',
    label: 'Goal MD',
    description: 'Objective, scope, milestones, and acceptance criteria',
  },
  {
    id: 'agent',
    label: 'Agent MD',
    description: 'Role, authority, tools, boundaries, and handoff',
  },
  {
    id: 'skill',
    label: 'Skill MD',
    description: 'Triggers, workflow, resources, safety, and verification',
  },
  {
    id: 'prompt',
    label: 'Prompt MD',
    description: 'Production-ready prompt with inputs and completion contract',
  },
  {
    id: 'design',
    label: 'Design MD',
    description: 'Visual direction, behavior, accessibility, and responsive states',
  },
  {
    id: 'test',
    label: 'Test MD',
    description: 'Test strategy, cases, fixtures, and pass criteria',
  },
  {
    id: 'policy',
    label: 'Policy MD',
    description: 'Rules, rationale, enforcement, exceptions, and auditability',
  },
  {
    id: 'context',
    label: 'Context MD',
    description: 'Compact verified project and decision context',
  },
  { id: 'custom', label: 'Custom MD', description: 'A tailored Markdown document from your brief' },
] as const;

const SECTIONS: Record<MarkdownDocumentKind, string> = {
  goal: 'Objective; requirements; scope and exclusions; milestones; Acceptance criteria; verification; risks and handoff.',
  agent:
    'Purpose; role; authority; inputs; tools; workflow; safety boundaries; outputs; verification and handoff.',
  skill:
    'Purpose; trigger conditions; required context; workflow; tools and resources; safety; examples; verification.',
  prompt:
    'Role; objective; context; exact requirements; constraints; inputs; workflow; completion contract; output format.',
  design:
    'Intent; visual language; layout; components; interaction and motion; responsive behavior; accessibility; acceptance criteria.',
  test: 'Scope; risk model; preconditions; fixtures; test cases; failure paths; expected results; evidence and exit criteria.',
  policy:
    'Purpose; definitions; mandatory rules; prohibited behavior; exceptions; enforcement; audit evidence; revision policy.',
  context:
    'Executive summary; verified facts; architecture; relevant files; decisions; constraints; open questions; source references.',
  custom:
    'Choose a clear information architecture suited to the brief, with actionable detail, constraints, and verification.',
};

function portableJoin(root: string, suffix: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${suffix.replace(/[\\/]/gu, separator)}`;
}

export function buildMarkdownCreationInstruction(input: {
  kind: MarkdownDocumentKind;
  brief: string;
  projectRoot: string | null;
  fullyLocal: boolean;
}): string {
  const destination = input.projectRoot
    ? portableJoin(input.projectRoot, 'docs/generated')
    : 'Jarvis Projects\\docs\\generated';
  const sourceRule = input.fullyLocal
    ? 'Do not use public online sources or cloud escalation. Use only attached files, the active project, and available local Context Map evidence.'
    : 'Public online research is allowed only when it materially improves accuracy and the current chat permits it. Cite the exact source URL and access date.';

  return [
    `[VibeSpace /md ${input.kind}] Create one polished Markdown document from this brief: ${input.brief.trim() || '(use the current chat request)'}`,
    `Required structure: ${SECTIONS[input.kind]}`,
    `Save it beneath ${destination}. Choose a short descriptive collision-safe filename ending in .md.`,
    'Use the existing approved file action exactly once with a payload shaped like {"actionId":"files.create","params":{"path":"<absolute path>","content":"<markdown>","root":"<active project root when available>","attachToChat":true}}.',
    'Never overwrite an existing file. If the name exists, create a numbered copy.',
    'Use relevant attached files, project files, chat context, and Context Map evidence. Never invent facts, citations, file paths, requirements, or completion evidence.',
    sourceRule,
    'After creation, attach the resulting file to this chat and report its exact absolute path.',
  ].join('\n');
}

export function isMarkdownDocumentKind(value: string): value is MarkdownDocumentKind {
  return MARKDOWN_DOCUMENT_OPTIONS.some((option) => option.id === value);
}

export function parseMarkdownSlashArgument(
  value: string,
): { kind: MarkdownDocumentKind; brief: string } | undefined {
  const [kindRaw = '', ...briefParts] = value.trim().split(/\s+/u);
  const kind = kindRaw.toLowerCase();
  if (!isMarkdownDocumentKind(kind)) return undefined;
  return { kind, brief: briefParts.join(' ').trim() };
}
