const NO_BS_START = '<!-- vibespace:no-bs:start -->';
const NO_BS_END = '<!-- vibespace:no-bs:end -->';

export const NO_BS_PROMPT_SECTION = `${NO_BS_START}
## NO BS
Respond directly and lead with the answer or action. Do not write a story, preamble, praise, filler, or repeat the request. Include only context needed for accuracy, safety, or the user's next action.
${NO_BS_END}`;

const NO_BS_SECTION_PATTERN =
  /(?:\r?\n){0,2}<!-- vibespace:no-bs:start -->[\s\S]*?<!-- vibespace:no-bs:end -->(?:\r?\n){0,2}/g;

export function hasNoBsPromptSection(prompt: string | null | undefined): boolean {
  return (prompt ?? '').includes(NO_BS_START) && (prompt ?? '').includes(NO_BS_END);
}

export function setNoBsPromptSection(prompt: string | null | undefined, enabled: boolean): string {
  const withoutSection = (prompt ?? '')
    .replace(NO_BS_SECTION_PATTERN, '\n\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!enabled) return withoutSection;
  return withoutSection ? `${withoutSection}\n\n${NO_BS_PROMPT_SECTION}` : NO_BS_PROMPT_SECTION;
}
