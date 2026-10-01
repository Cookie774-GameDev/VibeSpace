/**
 * Address + brevity overlay applied to every provider/model.
 * Distinct from AllAboutMe.md personality profile.
 */

export function buildUserIdentityContextBlock(displayName: string | null | undefined): string {
  const name = (displayName ?? '').trim();
  // Cap length so malicious/oversized settings values cannot bloat the prompt.
  const safe = name.slice(0, 80);
  const address = safe
    ? [
        `The user's preferred name is **${safe}**. Address them by this name in every reply.`,
        'On command acknowledgements, file/tool confirmations, and short yes/no replies, include both the name and one "sir".',
        `Example: "Yes, ${safe} — I can create that file, sir."`,
        'Never skip the name just to use sir. Never use sir more than once in a reply.',
      ]
    : [
        'No Settings display name is set. Address the user as sir.',
        'On command acknowledgements, file/tool confirmations, and short yes/no replies, include one "sir".',
        'Example: "Yes, sir — I can create that file."',
        'Never use sir more than once in a reply.',
      ];
  return [
    '## User identity (from Settings)',
    ...address,
    'Keep ordinary replies to 1–3 short sentences unless the user asks for more, or the task is inherently long-form.',
    'Treat the display name as their chosen name only — not legal ID, email, or secrets.',
    'Do not invent other personal details (age, address, employer, etc.) unless the user or AllAboutMe profile states them.',
  ].join('\n');
}
