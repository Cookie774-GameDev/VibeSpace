import {
  buildAllAboutMeMarkdown,
  type AllAboutMeAnswers,
} from './profile';

export type AllAboutMeCompletion = (prompt: string) => Promise<string>;

export interface AllAboutMeRevisionInput {
  existingMarkdown: string;
  recentUserMessages: string[];
}

export interface AllAboutMeRetakeUpdateInput {
  existingMarkdown: string;
  answers: AllAboutMeAnswers;
}

const MAX_MESSAGE_CHARS = 1000;
const MAX_RECENT_MESSAGES = 12;

function validAllAboutMeMarkdown(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('# AllAboutMe.md') && trimmed.length > '# AllAboutMe.md'.length;
}

function cleanModelMarkdown(value: string): string {
  return value
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function serializeAnswers(answers: AllAboutMeAnswers): string {
  return JSON.stringify(answers, null, 2);
}

function boundedMessages(messages: string[]): string {
  return messages
    .slice(-MAX_RECENT_MESSAGES)
    .map((message, index) => {
      const trimmed = message.trim();
      const bounded =
        trimmed.length > MAX_MESSAGE_CHARS
          ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}...[truncated]`
          : trimmed;
      return `${index + 1}. ${bounded}`;
    })
    .join('\n');
}

export function buildAllAboutMeGenerationPrompt(answers: AllAboutMeAnswers): string {
  return [
    'Create a detailed `AllAboutMe.md` personality profile for Jarvis.',
    '',
    'Use the quiz answers below to infer tone, communication style, preferences, interests, dislikes, strong reactions, mood, and writing voice.',
    'Make the document useful for matching the user when drafting replies, YouTube comments, app messages, and Jarvis chat responses.',
    'Do not invent private facts, credentials, addresses, or unsupported claims.',
    'Return only markdown. The first line must be exactly `# AllAboutMe.md`.',
    '',
    'Quiz answers:',
    '```json',
    serializeAnswers(answers),
    '```',
  ].join('\n');
}

export function buildAllAboutMeRetakeUpdatePrompt(input: AllAboutMeRetakeUpdateInput): string {
  return [
    'You update an existing `AllAboutMe.md` after a retake of the full All About Me test.',
    '',
    'This is not a simple overwrite. Treat the existing markdown as the stable long-term profile and the retake as fresher evidence.',
    'Update personality scores, tone patterns, preferences, writing style, priorities, design taste, coding preferences, scenario reactions, and Jarvis guidance when the new answers are more current or more specific.',
    'Preserve durable facts that are still compatible with the retake. Remove or soften stale claims only when the new test clearly contradicts them.',
    'Do not add secrets, credentials, exact private URLs, addresses, or unsupported facts.',
    'Make the output very detailed, cleanly sectioned, and practical for Jarvis to use across chat, coding, public replies, YouTube comments, app planning, and UI/design help.',
    'Return only the complete markdown document. The first line must be exactly `# AllAboutMe.md`.',
    '',
    'Existing AllAboutMe.md:',
    '```markdown',
    input.existingMarkdown.trim(),
    '```',
    '',
    'Quiz answers from the retake:',
    '```json',
    serializeAnswers(input.answers),
    '```',
  ].join('\n');
}

export function buildAllAboutMeRevisionPrompt(input: AllAboutMeRevisionInput): string {
  return [
    'Revise `AllAboutMe.md` using recent Jarvis chat patterns.',
    '',
    'Preserve the existing profile. Improve it only when the recent user messages show repeated tone, preference, interest, dislike, urgency, mood, or communication patterns.',
    'Do not delete stable sections unless they are contradicted by newer repeated behavior.',
    'Do not add secrets, private credentials, exact URLs, or unsupported biographical claims.',
    'Return the complete updated markdown document. The first line must be exactly `# AllAboutMe.md`.',
    '',
    'Existing profile:',
    '```markdown',
    input.existingMarkdown.trim(),
    '```',
    '',
    'Recent user messages:',
    boundedMessages(input.recentUserMessages),
  ].join('\n');
}

export async function generateAllAboutMeMarkdown(
  answers: AllAboutMeAnswers,
  complete: AllAboutMeCompletion,
  existingMarkdown?: string,
): Promise<string> {
  // Network / runtime failures propagate so the UI can show actionable errors.
  // Only fall back to the deterministic template when the model responds with
  // unusable markdown (not when the local/cloud runtime is down).
  const prompt = existingMarkdown?.trim()
    ? buildAllAboutMeRetakeUpdatePrompt({ existingMarkdown, answers })
    : buildAllAboutMeGenerationPrompt(answers);
  const markdown = cleanModelMarkdown(await complete(prompt));
  return validAllAboutMeMarkdown(markdown) ? markdown : buildAllAboutMeMarkdown(answers);
}

export async function reviseAllAboutMeMarkdown(
  input: AllAboutMeRevisionInput,
  complete: AllAboutMeCompletion,
): Promise<string> {
  try {
    const markdown = cleanModelMarkdown(await complete(buildAllAboutMeRevisionPrompt(input)));
    return validAllAboutMeMarkdown(markdown) ? markdown : input.existingMarkdown;
  } catch {
    return input.existingMarkdown;
  }
}
