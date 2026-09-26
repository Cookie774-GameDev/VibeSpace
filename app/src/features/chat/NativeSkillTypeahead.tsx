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
import { RotateCcw } from 'lucide-react';
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
    <section className="w-full overflow-hidden rounded-lg border border-border bg-panel shadow-lg">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{harnessLabel} skills</h3>
          <p className="text-xs text-muted-foreground">Choose a skill for this prompt</p>
        </div>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          aria-label="Refresh skills"
          onClick={onRefresh}
          disabled={loading}
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Refresh
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
            onClick={onRefresh}
          >
            Retry
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
        className="max-h-72 space-y-1 overflow-y-auto p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                if (!available) return;
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
              className={`cursor-pointer rounded-md border px-2.5 py-2 outline-none transition-colors ${
                key === effectiveActiveKey || key === selectedKey
                  ? 'border-accent-cyan/60 bg-accent-cyan/10'
                  : 'border-transparent hover:border-border hover:bg-accent/60'
              } ${available ? '' : 'cursor-not-allowed opacity-60'}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    ${skill.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                    {description}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={`block text-[10px] font-semibold uppercase tracking-wide ${
                      available ? 'text-accent-cyan' : 'text-muted-foreground'
                    }`}
                  >
                    {available ? 'Available' : 'Unavailable'}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {harness === 'opencode'
                      ? /(?:^|[\\/])\.codex[\\/]skills[\\/]/iu.test(skill.path) ? 'Codex origin' : 'OpenCode'
                      : SCOPE_LABELS[skill.scope]}
                  </span>
                </span>
              </div>
              {!available && (discoveryError || !skill.enabled) && (
                <span className="mt-1 block text-xs text-destructive">
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
    </section>
  );
});
