import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { RotateCcw, Sparkles } from 'lucide-react';
import type {
  CodexDiscoveredSkill,
  CodexSkillDiscoveryError,
} from '@/lib/ai/adapters/codexAppServerProtocol';
import { nativeSkillSelectionKey } from './nativeSkillMention';

export interface NativeSkillTypeaheadProps {
  harness?: 'codex' | 'opencode';
  query: string;
  skills: readonly CodexDiscoveredSkill[];
  errors?: readonly CodexSkillDiscoveryError[];
  loading?: boolean;
  error?: string | null;
  selectedKey?: string | null;
  onHoverKey?: (key: string) => void;
  onSelect: (skill: CodexDiscoveredSkill) => void;
  onRefresh: () => void;
  needsProjectFolder?: boolean;
  onChooseProjectFolder?: () => void;
}

export interface NativeSkillTypeaheadHandle {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
  getListboxId: () => string;
  getActiveDescendantId: () => string | undefined;
}

const SCOPE_LABELS: Record<CodexDiscoveredSkill['scope'], string> = {
  user: 'User',
  repo: 'Repo',
  system: 'System',
  admin: 'Admin',
};
const NO_ERRORS: readonly CodexSkillDiscoveryError[] = [];

export const NativeSkillTypeahead = forwardRef<
  NativeSkillTypeaheadHandle,
  NativeSkillTypeaheadProps
>(function NativeSkillTypeahead(
  {
    harness = 'codex',
    query,
    skills,
    errors = NO_ERRORS,
    loading = false,
    error = null,
    selectedKey = null,
    onHoverKey,
    onSelect,
    onRefresh,
    needsProjectFolder = false,
    onChooseProjectFolder,
  },
  ref,
) {
  const listboxId = useId();
  const harnessLabel = harness === 'opencode' ? 'OpenCode' : 'Codex';
  const normalizedQuery = query.trim().replace(/^\$/u, '').toLocaleLowerCase();
  const discoveryErrors = useMemo(
    () => new Map(errors.map((entry) => [`${entry.cwd}\u0000${entry.path}`, entry.message])),
    [errors],
  );
  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) =>
        `${skill.name}\n${skill.shortDescription ?? ''}\n${skill.description}\n${skill.scope}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      ),
    [normalizedQuery, skills],
  );
  const selectableSkills = useMemo(
    () =>
      filteredSkills.filter(
        (skill) => skill.enabled && !discoveryErrors.has(`${skill.cwd}\u0000${skill.path}`),
      ),
    [discoveryErrors, filteredSkills],
  );
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    const selected = skills.find(
      (skill) => skill.enabled && nativeSkillSelectionKey(skill) === selectedKey,
    );
    return selected ? nativeSkillSelectionKey(selected) : null;
  });
  const activeKeyRef = useRef(activeKey);

  useEffect(() => {
    setActiveKey((current) => {
      const selected = selectableSkills.find(
        (skill) => nativeSkillSelectionKey(skill) === selectedKey,
      );
      if (selected) {
        const key = nativeSkillSelectionKey(selected);
        activeKeyRef.current = key;
        return key;
      }
      if (selectableSkills.some((skill) => nativeSkillSelectionKey(skill) === current)) {
        return current;
      }
      const key = selectableSkills[0] ? nativeSkillSelectionKey(selectableSkills[0]) : null;
      activeKeyRef.current = key;
      return key;
    });
  }, [selectableSkills, selectedKey]);

  const effectiveActiveKey = selectableSkills.some(
    (skill) => nativeSkillSelectionKey(skill) === activeKey,
  )
    ? activeKey
    : selectedKey;
  const activeIndex = selectableSkills.findIndex(
    (skill) => nativeSkillSelectionKey(skill) === effectiveActiveKey,
  );
  const activeOptionId =
    activeIndex >= 0
      ? `${listboxId}-option-${filteredSkills.indexOf(selectableSkills[activeIndex])}`
      : undefined;

  function moveSelection(direction: -1 | 1): void {
    if (selectableSkills.length === 0) return;
    const nextIndex =
      activeIndex < 0
        ? direction > 0
          ? 0
          : selectableSkills.length - 1
        : (activeIndex + direction + selectableSkills.length) % selectableSkills.length;
    const key = nativeSkillSelectionKey(selectableSkills[nextIndex]);
    activeKeyRef.current = key;
    setActiveKey(key);
    onHoverKey?.(key);
  }

  function selectActive(): void {
    const index = selectableSkills.findIndex(
      (skill) => nativeSkillSelectionKey(skill) === activeKeyRef.current,
    );
    if (index >= 0) onSelect(selectableSkills[index]);
  }

  useImperativeHandle(ref, () => ({
    moveUp: () => moveSelection(-1),
    moveDown: () => moveSelection(1),
    selectCurrent: selectActive,
    getListboxId: () => listboxId,
    getActiveDescendantId: () => activeOptionId,
  }));

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (selectableSkills.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : selectableSkills.length - 1;
      const key = nativeSkillSelectionKey(selectableSkills[index]);
      activeKeyRef.current = key;
      setActiveKey(key);
      onHoverKey?.(key);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      selectActive();
    }
  }

  return (
    <section
      className="jarvis-slash-dropdown overflow-hidden rounded-[14px] border border-border-mid/80 bg-elevated/95 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)] backdrop-blur-xl"
      style={{ width: 'min(338px, 90vw)' }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-panel/90 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-copper/55 bg-background/70 text-accent-copper shadow-[inset_0_0_10px_hsl(var(--accent-copper)/0.28),0_0_13px_hsl(var(--accent-copper)/0.2)]">
            <Sparkles aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0">
            <h3 className="truncate text-[17px] font-medium leading-5">$skill</h3>
            <p className="text-xs leading-4 text-muted-foreground">Choose a skill for this prompt</p>
          </span>
        </div>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          aria-label={needsProjectFolder ? 'Choose project folder' : 'Refresh skills'}
          onClick={needsProjectFolder ? onChooseProjectFolder : onRefresh}
          disabled={loading}
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          {needsProjectFolder ? 'Choose folder' : 'Refresh'}
        </button>
      </header>

      {loading && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Loading skills…
        </p>
      )}
      {error && (
        <div className="flex items-start justify-between gap-3 px-3 py-2" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-foreground underline underline-offset-2"
            onClick={needsProjectFolder ? onChooseProjectFolder : onRefresh}
          >
            {needsProjectFolder ? 'Choose folder' : 'Retry'}
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <ul
          aria-label="Skill discovery errors"
          className="space-y-1 border-b border-border px-3 py-2"
        >
          {errors.map((entry) => (
            <li
              key={`${entry.cwd}\u0000${entry.path}`}
              className="truncate text-xs text-destructive"
              role="status"
              title={`${entry.path}: ${entry.message}`}
            >
              Could not load {entry.path}: {entry.message}
            </li>
          ))}
        </ul>
      )}

      <div
        id={listboxId}
        role="listbox"
        aria-label={`${harnessLabel} skills`}
        aria-activedescendant={activeOptionId}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        className="max-h-[238px] overflow-y-auto py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {filteredSkills.map((skill, index) => {
          const key = nativeSkillSelectionKey(skill);
          const discoveryError = discoveryErrors.get(`${skill.cwd}\u0000${skill.path}`);
          const available = skill.enabled && !discoveryError;
          const description = skill.shortDescription || skill.description;
          return (
            <div
              id={`${listboxId}-option-${index}`}
              key={key}
              role="option"
              aria-selected={key === effectiveActiveKey}
              aria-disabled={!available}
              tabIndex={-1}
              onMouseMove={() => {
                if (!available || activeKeyRef.current === key) return;
                activeKeyRef.current = key;
                setActiveKey(key);
                onHoverKey?.(key);
              }}
              onClick={() => {
                if (!available) return;
                activeKeyRef.current = key;
                setActiveKey(key);
                onSelect(skill);
              }}
              className={`mx-2 mb-1 cursor-pointer rounded-[12px] border px-3 py-2.5 outline-none transition-colors ${
                key === effectiveActiveKey || key === selectedKey
                  ? 'border-accent-copper/60 bg-accent-copper/12 shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]'
                  : 'border-transparent hover:border-border hover:bg-muted/70'
              } ${available ? '' : 'cursor-not-allowed opacity-60'}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/35 text-muted-foreground">
                  <Sparkles aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium leading-5 text-foreground">
                    ${skill.name}
                  </span>
                  <span
                    className="max-h-8 overflow-hidden text-xs leading-4 text-muted-foreground"
                    style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
                  >
                    {description}
                  </span>
                </span>
                <span className="shrink-0 self-start text-right">
                  <span
                    className={`block text-[10px] font-medium ${
                      available ? 'text-accent-cyan' : 'text-muted-foreground'
                    }`}
                  >
                    {available ? 'Available' : 'Unavailable'}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {harness === 'opencode'
                      ? /(?:^|[\\/])\.codex[\\/]skills[\\/]/iu.test(skill.path) ? 'Codex origin' : 'OpenCode'
                      : SCOPE_LABELS[skill.scope]}
                  </span>
                </span>
              </div>
              {!available && (discoveryError || !skill.enabled) && (
                <span className="ml-10 mt-1 block text-xs text-destructive">
                  {discoveryError || `Disabled in ${harnessLabel}`}
                </span>
              )}
            </div>
          );
        })}
        {!loading && !error && filteredSkills.length === 0 && (
          <p className="px-2.5 py-4 text-center text-xs text-muted-foreground" role="status">
            {skills.length === 0
              ? `No ${harnessLabel} skills were discovered.`
              : 'No skills match this search.'}
          </p>
        )}
      </div>
      <footer className="flex items-center gap-3 border-t border-border bg-panel/90 px-4 py-2.5 text-[11px] text-muted-foreground">
        <span><kbd className="jarvis-kbd !text-foreground">up/down</kbd> nav</span>
        <span><kbd className="jarvis-kbd !text-foreground">enter</kbd> select</span>
        <span className="ml-auto"><kbd className="jarvis-kbd !text-foreground">esc</kbd></span>
      </footer>
    </section>
  );
});
