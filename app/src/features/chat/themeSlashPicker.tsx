import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Code2, Palette } from 'lucide-react';
import { parseSelectableTheme, type SelectableTheme } from '@/features/appearance/themeContract';
import { SELECTABLE_THEMES } from '@/features/appearance/themes';
import { applyThemeToDocument } from '@/stores/ui';
import { CONSOLE_PROFILES, type ConsoleProfile } from './agentic-console/preferences';
import {
  SlashCommandOptionPicker,
  type SlashCommandOption,
  type SlashCommandOptionPickerRef,
} from './SlashCommandOptionPicker';

type ThemePreviewPalette = Readonly<{
  background: string;
  surface: string;
  added: string;
  addedSurface: string;
  removed: string;
  removedSurface: string;
  text: string;
  muted: string;
  keyword: string;
  string: string;
}>;

const DEFAULT_THEME_PREVIEW_PALETTE: ThemePreviewPalette = {
  background: '#211b18',
  surface: '#2d2520',
  added: '#9fc184',
  addedSurface: '#203a27',
  removed: '#dc7467',
  removedSurface: '#4b2422',
  text: '#f4e8d4',
  muted: '#967f70',
  keyword: '#e4a363',
  string: '#d8c579',
};

const THEME_PREVIEW_PALETTES: Readonly<Record<string, ThemePreviewPalette>> = {
  jarvis: {
    background: '#050812',
    surface: '#0b1522',
    added: '#50e58a',
    addedSurface: '#123d29',
    removed: '#ff7168',
    removedSurface: '#4d1d24',
    text: '#d7fbff',
    muted: '#5d8196',
    keyword: '#55d9ff',
    string: '#d0f078',
  },
  default: DEFAULT_THEME_PREVIEW_PALETTE,
  monochrome: {
    background: '#0b0d12',
    surface: '#171a20',
    added: '#71d6a8',
    addedSurface: '#17382c',
    removed: '#e2727b',
    removedSurface: '#452329',
    text: '#f4f4f5',
    muted: '#71717a',
    keyword: '#d4d4d8',
    string: '#a1a1aa',
  },
  warm: {
    background: '#f8f0df',
    surface: '#eee0c7',
    added: '#66894e',
    addedSurface: '#dce8ca',
    removed: '#b74740',
    removedSurface: '#f1d0c7',
    text: '#4a2d20',
    muted: '#9a7b65',
    keyword: '#a45e32',
    string: '#7d7435',
  },
  'paper-white': {
    background: '#f7f6f2',
    surface: '#e9e7e1',
    added: '#297a43',
    addedSurface: '#d8eddd',
    removed: '#b43c42',
    removedSurface: '#f3d9db',
    text: '#24272d',
    muted: '#777b82',
    keyword: '#285d9a',
    string: '#7c5d17',
  },
  'solar-sand': {
    background: '#f4e6c8',
    surface: '#e7d4ad',
    added: '#577b38',
    addedSurface: '#d8e3be',
    removed: '#b34b42',
    removedSurface: '#efd0c4',
    text: '#47362a',
    muted: '#93775e',
    keyword: '#a75f2e',
    string: '#7c721f',
  },
  'sakura-mist': {
    background: '#fbf2f4',
    surface: '#f0dde3',
    added: '#4f8565',
    addedSurface: '#dbeadf',
    removed: '#b94c68',
    removedSurface: '#f2d5df',
    text: '#533e49',
    muted: '#a17b8e',
    keyword: '#9b4f86',
    string: '#8b6c35',
  },
  icebound: {
    background: '#edf7fb',
    surface: '#dcecf3',
    added: '#26785f',
    addedSurface: '#d1ebe2',
    removed: '#af4c5c',
    removedSurface: '#efd7dd',
    text: '#223c4b',
    muted: '#7894a2',
    keyword: '#2674a2',
    string: '#517a35',
  },
  'vibespace-amber': {
    background: '#1f1711',
    surface: '#312319',
    added: '#a1bd75',
    addedSurface: '#2d3b24',
    removed: '#e47967',
    removedSurface: '#502820',
    text: '#f0dfc5',
    muted: '#9b7961',
    keyword: '#eca461',
    string: '#d7c36c',
  },
  graphite: {
    background: '#20242b',
    surface: '#30353d',
    added: '#7dcf92',
    addedSurface: '#24412e',
    removed: '#ec747a',
    removedSurface: '#512a30',
    text: '#e5e9ef',
    muted: '#7f8a98',
    keyword: '#72b7e8',
    string: '#d6c67b',
  },
  'midnight-blue': {
    background: '#0b1425',
    surface: '#14233a',
    added: '#63d39a',
    addedSurface: '#153c31',
    removed: '#f16e7c',
    removedSurface: '#4c2532',
    text: '#dcecff',
    muted: '#6682a2',
    keyword: '#68b9ff',
    string: '#d5d77a',
  },
  'monokai-ember': {
    background: '#211f20',
    surface: '#302c2e',
    added: '#a5d45d',
    addedSurface: '#334027',
    removed: '#f46673',
    removedSurface: '#51262c',
    text: '#f4f1e8',
    muted: '#837c7a',
    keyword: '#f17c95',
    string: '#e4d268',
  },
  'matrix-moss': {
    background: '#07120c',
    surface: '#112218',
    added: '#5ee883',
    addedSurface: '#163b24',
    removed: '#e26166',
    removedSurface: '#432227',
    text: '#c6f7d1',
    muted: '#557d61',
    keyword: '#72e29a',
    string: '#bddc67',
  },
  'oled-void': {
    background: '#000000',
    surface: '#111111',
    added: '#55db8b',
    addedSurface: '#123622',
    removed: '#ff626f',
    removedSurface: '#421c22',
    text: '#f7f7f7',
    muted: '#666666',
    keyword: '#70c7ff',
    string: '#d9d76b',
  },
};

export function isGlobalThemePickerCommand(command: string): boolean {
  return command === 'appearance';
}

function paletteFor(themeId: string): ThemePreviewPalette {
  return THEME_PREVIEW_PALETTES[themeId] ?? DEFAULT_THEME_PREVIEW_PALETTE;
}

function CodeLine({
  marker,
  color,
  width,
}: {
  marker: '+' | '−';
  color: string;
  width: CSSProperties['width'];
}) {
  return (
    <span className="flex h-2 items-center gap-1">
      <span className="w-2 text-[8px] font-bold leading-none" style={{ color }}>
        {marker}
      </span>
      <span className="h-[2px] rounded-full opacity-90" style={{ width, backgroundColor: color }} />
    </span>
  );
}

export function ThemeCodePreview({ theme, label }: { theme: string; label: string }) {
  const palette = paletteFor(theme);
  return (
    <span
      role="img"
      aria-label={`${label} code colors`}
      data-testid="theme-code-preview"
      data-theme-code-preview={theme}
      className="flex h-9 w-[58px] shrink-0 flex-col justify-center gap-0.5 rounded-md border border-white/10 px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={{ backgroundColor: palette.background, color: palette.text }}
    >
      <CodeLine marker="−" color={palette.removed} width="65%" />
      <CodeLine marker="+" color={palette.added} width="82%" />
      <span
        aria-hidden="true"
        className="ml-3 block h-[2px] w-5 rounded-full opacity-60"
        style={{ backgroundColor: palette.text }}
      />
    </span>
  );
}

function DiffLine({
  number,
  marker,
  children,
  palette,
}: {
  number: number;
  marker?: '+' | '−';
  children: React.ReactNode;
  palette: ThemePreviewPalette;
}) {
  const isAdded = marker === '+';
  const isRemoved = marker === '−';
  return (
    <div
      className="grid grid-cols-[24px_14px_1fr] items-center px-2 text-[11px] leading-5"
      style={{
        color: palette.text,
        backgroundColor: isAdded
          ? palette.addedSurface
          : isRemoved
            ? palette.removedSurface
            : 'transparent',
      }}
    >
      <span className="select-none text-right" style={{ color: palette.muted }}>
        {number}
      </span>
      <span
        className="select-none text-center"
        style={{ color: isAdded ? palette.added : palette.removed }}
      >
        {marker ?? ''}
      </span>
      <code className="whitespace-pre font-mono">{children}</code>
    </div>
  );
}

export function ThemeDiffPreview({ theme }: { theme: string }) {
  const palette = paletteFor(theme);
  return (
    <div
      data-testid="theme-diff-preview"
      data-code-theme={theme}
      aria-label="Selected code output color preview"
      className="border-t border-border px-2 py-2"
      style={{ backgroundColor: palette.background }}
    >
      <div className="overflow-hidden rounded-md" style={{ backgroundColor: palette.surface }}>
        <DiffLine number={12} palette={palette}>
          <span style={{ color: palette.keyword }}>fn greet</span>
          {'(name: &str) -> String {'}
        </DiffLine>
        <DiffLine number={13} marker="−" palette={palette}>
          {'  format!('}
          <span style={{ color: palette.string }}>"Hello, {'{}'}!"</span>
          {', name)'}
        </DiffLine>
        <DiffLine number={13} marker="+" palette={palette}>
          {'  format!('}
          <span style={{ color: palette.string }}>"Hello, {'{name}'}!"</span>
          {')'}
        </DiffLine>
        <DiffLine number={14} palette={palette}>
          {'}'}
        </DiffLine>
      </div>
    </div>
  );
}

export interface ThemeSlashPickerRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
  cancel: () => void;
}

interface ThemeSlashPickerProps {
  commandLabel: 'appearance';
  initialTheme: SelectableTheme;
  onCommit: (theme: SelectableTheme) => void;
  onCancel: () => void;
}

export const ThemeSlashPicker = forwardRef<ThemeSlashPickerRef, ThemeSlashPickerProps>(
  function ThemeSlashPicker({ commandLabel, initialTheme, onCommit, onCancel }, ref) {
    const pickerRef = useRef<SlashCommandOptionPickerRef>(null);
    const committedThemeRef = useRef(initialTheme);
    const [selectedTheme, setSelectedTheme] = useState<SelectableTheme>(initialTheme);

    const previewTheme = (theme: SelectableTheme) => {
      setSelectedTheme(theme);
      applyThemeToDocument(theme);
    };

    const options = useMemo<SlashCommandOption[]>(
      () =>
        SELECTABLE_THEMES.map((theme) => ({
          id: theme.id,
          label: theme.label,
          description: theme.description,
          metadata: theme.id === initialTheme ? 'current' : undefined,
          leading: <ThemeCodePreview theme={theme.id} label={theme.label} />,
        })),
      [initialTheme],
    );

    useImperativeHandle(ref, () => ({
      moveUp: () => pickerRef.current?.moveUp(),
      moveDown: () => pickerRef.current?.moveDown(),
      selectCurrent: () => pickerRef.current?.selectCurrent(),
      cancel: () => {
        applyThemeToDocument(committedThemeRef.current);
        onCancel();
      },
    }));

    useEffect(
      () => () => {
        applyThemeToDocument(committedThemeRef.current);
      },
      [],
    );

    return (
      <SlashCommandOptionPicker
        ref={pickerRef}
        commandLabel={commandLabel}
        commandIcon={Palette}
        options={options}
        selectedId={selectedTheme}
        query=""
        preview={<ThemeDiffPreview theme={selectedTheme} />}
        onHoverId={(id) => {
          const theme = parseSelectableTheme(id);
          if (theme) previewTheme(theme);
        }}
        onSelect={(option) => {
          const theme = parseSelectableTheme(option.id);
          if (!theme) return;
          committedThemeRef.current = theme;
          onCommit(theme);
        }}
      />
    );
  },
);

interface ConsoleThemeSlashPickerProps {
  initialProfile: ConsoleProfile;
  onCommit: (profile: ConsoleProfile) => void;
  onCancel: () => void;
}

const CONSOLE_PROFILE_IDS = new Set<string>(CONSOLE_PROFILES.map((profile) => profile.id));

export const ConsoleThemeSlashPicker = forwardRef<
  ThemeSlashPickerRef,
  ConsoleThemeSlashPickerProps
>(function ConsoleThemeSlashPicker({ initialProfile, onCommit, onCancel }, ref) {
  const pickerRef = useRef<SlashCommandOptionPickerRef>(null);
  const [selectedProfile, setSelectedProfile] = useState<ConsoleProfile>(initialProfile);
  const options = useMemo<SlashCommandOption[]>(
    () =>
      CONSOLE_PROFILES.map((profile) => ({
        id: profile.id,
        label: profile.label,
        metadata: profile.id === initialProfile ? 'current' : undefined,
        leading: <ThemeCodePreview theme={profile.id} label={profile.label} />,
      })),
    [initialProfile],
  );

  useImperativeHandle(ref, () => ({
    moveUp: () => pickerRef.current?.moveUp(),
    moveDown: () => pickerRef.current?.moveDown(),
    selectCurrent: () => pickerRef.current?.selectCurrent(),
    cancel: onCancel,
  }));

  return (
    <SlashCommandOptionPicker
      ref={pickerRef}
      commandLabel="theme"
      commandIcon={Code2}
      options={options}
      selectedId={selectedProfile}
      query=""
      preview={<ThemeDiffPreview theme={selectedProfile} />}
      onHoverId={(id) => {
        if (CONSOLE_PROFILE_IDS.has(id)) setSelectedProfile(id as ConsoleProfile);
      }}
      onSelect={(option) => {
        if (CONSOLE_PROFILE_IDS.has(option.id)) onCommit(option.id as ConsoleProfile);
      }}
    />
  );
});
