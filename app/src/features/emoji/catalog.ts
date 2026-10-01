export type VibeSpaceEmojiDefinition = Readonly<{
  id: string;
  name: string;
  motif: string;
  palette: string;
  icon:
    | 'spark'
    | 'builder'
    | 'navigator'
    | 'analyst'
    | 'guardian'
    | 'creator'
    | 'researcher'
    | 'debugger'
    | 'communicator'
    | 'automator';
  foreground: string;
  background: string;
}>;

const MOTIFS = [
  ['spark', 'Spark'],
  ['builder', 'Builder'],
  ['navigator', 'Navigator'],
  ['analyst', 'Analyst'],
  ['guardian', 'Guardian'],
  ['creator', 'Creator'],
  ['researcher', 'Researcher'],
  ['debugger', 'Debugger'],
  ['communicator', 'Communicator'],
  ['automator', 'Automator'],
] as const;

const PALETTES = [
  ['aurora', 'Aurora', '#d8fbff', 'linear-gradient(145deg, #155e75, #6d28d9)'],
  ['ember', 'Ember', '#fff2df', 'linear-gradient(145deg, #9a3412, #be123c)'],
  ['ocean', 'Ocean', '#e0f2fe', 'linear-gradient(145deg, #075985, #1d4ed8)'],
  ['orchid', 'Orchid', '#fae8ff', 'linear-gradient(145deg, #86198f, #6d28d9)'],
  ['solar', 'Solar', '#422006', 'linear-gradient(145deg, #fde047, #fb923c)'],
  ['forest', 'Forest', '#ecfdf5', 'linear-gradient(145deg, #166534, #0f766e)'],
  ['frost', 'Frost', '#164e63', 'linear-gradient(145deg, #ecfeff, #a5f3fc)'],
  ['rose', 'Rose', '#fff1f2', 'linear-gradient(145deg, #be123c, #9f1239)'],
  ['copper', 'Copper', '#fff7ed', 'linear-gradient(145deg, #9a3412, #713f12)'],
  ['midnight', 'Midnight', '#e0e7ff', 'linear-gradient(145deg, #0f172a, #312e81)'],
] as const;

export const DEFAULT_VIBESPACE_EMOJI_ID = 'vibe:aurora-spark';
export const VIBESPACE_EMOJIS: readonly VibeSpaceEmojiDefinition[] = Object.freeze(
  PALETTES.flatMap(([paletteId, palette, foreground, background]) =>
    MOTIFS.map(([icon, motif]) =>
      Object.freeze({
        id: `vibe:${paletteId}-${icon}`,
        name: `${palette} ${motif}`,
        motif,
        palette,
        icon,
        foreground,
        background,
      }),
    ),
  ),
);

export function findVibeSpaceEmoji(id: string): VibeSpaceEmojiDefinition | undefined {
  return VIBESPACE_EMOJIS.find((emoji) => emoji.id === id);
}

export function searchVibeSpaceEmojis(query: string): readonly VibeSpaceEmojiDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return VIBESPACE_EMOJIS;
  return VIBESPACE_EMOJIS.filter((emoji) =>
    `${emoji.name} ${emoji.motif} ${emoji.palette}`.toLowerCase().includes(normalized),
  );
}
