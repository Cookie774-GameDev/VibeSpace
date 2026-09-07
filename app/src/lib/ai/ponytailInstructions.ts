import skill from '../../../.jarvis/skills/ponytail/SKILL.md?raw';

// Adapted from DietrichGebert/ponytail hooks/ponytail-instructions.js at
// 356918eba965ee1eac64bd3a7f0dd02108350de5 (MIT). VibeSpace selects full mode;
// global hook state and filesystem access are intentionally unnecessary here.
// License: app/.jarvis/skills/ponytail/LICENSE.txt.
const body = skill.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/)
  .filter(line => {
    const label = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/)?.[1]
      ?? line.match(/^-\s*([^:]+):\s*"/)?.[1];
    const mode = label?.trim().toLowerCase();
    return !mode || !['lite', 'full', 'ultra'].includes(mode) || mode === 'full';
  }).join('\n');

export const ponytailInstructions = [
  'PONYTAIL MODE ACTIVE — level: full',
  'Current VibeSpace /mode selection controls activation for this turn. These upstream coding rules apply only while Token Saver is selected; they do not override explicit user requirements or permission boundaries. For non-coding requests, answer normally and concisely.',
  body,
].join('\n\n');
