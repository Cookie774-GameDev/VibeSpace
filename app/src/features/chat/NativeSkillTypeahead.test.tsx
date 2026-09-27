import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithRef, ComponentRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CodexDiscoveredSkill,
  CodexSkillDiscoveryError,
} from '@/lib/ai/adapters/codexAppServerProtocol';
import { NativeSkillTypeahead } from './NativeSkillTypeahead';
import { nativeSkillSelectionKey } from './nativeSkillMention';

const skills: CodexDiscoveredSkill[] = [
  {
    cwd: 'C:/workspace/app',
    name: 'deploy-preview',
    description: 'Build and deploy a preview',
    shortDescription: 'Deploy a preview',
    path: 'C:/workspace/app/.codex/skills/deploy-preview/SKILL.md',
    scope: 'repo',
    enabled: true,
    pluginId: null,
  },
  {
    cwd: 'C:/workspace/app',
    name: 'review-diff',
    description: 'Review the current changes',
    path: 'C:/workspace/app/.codex/skills/review-diff/SKILL.md',
    scope: 'user',
    enabled: true,
    pluginId: null,
  },
  {
    cwd: 'C:/workspace/app',
    name: 'disabled-skill',
    description: 'This skill is disabled',
    path: 'C:/workspace/app/.codex/skills/disabled-skill/SKILL.md',
    scope: 'repo',
    enabled: false,
    pluginId: null,
  },
];

function renderPicker(overrides: Partial<ComponentPropsWithRef<typeof NativeSkillTypeahead>> = {}) {
  return render(
    <NativeSkillTypeahead
      query=""
      skills={skills}
      selectedKey={nativeSkillSelectionKey(skills[0])}
      onSelect={vi.fn()}
      onRefresh={vi.fn()}
      {...overrides}
    />,
  );
}

describe('NativeSkillTypeahead', () => {
  it('distinguishes Codex origin from OpenCode native catalog entries', () => {
    renderPicker({ harness: 'opencode', skills: [skills[0]!, {
      ...skills[1]!, path: 'C:/workspace/app/.opencode/skills/review-diff/SKILL.md',
    }] });
    expect(screen.getByRole('listbox', { name: 'OpenCode skills' })).toBeTruthy();
    const selected = screen.getByRole('option', { name: /deploy-preview/i });
    expect(selected.textContent).toContain('Codex origin');
    expect(selected.textContent).not.toContain('Repo');
    expect(screen.getByRole('option', { name: /review-diff/i }).textContent).toContain('OpenCode');
  });

  it('shows exact skill identity, description, scope, and available state', () => {
    renderPicker();
    const selected = screen.getByRole('option', { name: /deploy-preview/i });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.getAttribute('aria-disabled')).toBe('false');
    expect(screen.getByText('Deploy a preview')).toBeTruthy();
    expect(selected.textContent).toContain('Repo');
    expect(selected.textContent).toContain('Available');
  });

  it('keeps a concise summary visible without expanding the full skill instructions', () => {
    const fullDescription = 'A long skill manifest description that should not fill the picker row. '.repeat(8);
    renderPicker({
      skills: [{
        ...skills[0]!,
        description: fullDescription,
        shortDescription: 'Ship a preview',
      }],
    });

    const option = screen.getByRole('option', { name: /deploy-preview/i });
    expect(option.textContent).toContain('Ship a preview');
    expect(option.textContent).not.toContain(fullDescription);
  });

  it('filters the list by the typed query and selects by keyboard or mouse', () => {
    const onSelect = vi.fn();
    const onHoverKey = vi.fn();
    const { rerender } = renderPicker({ query: 'current changes' });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /review-diff/i })).toBeTruthy();

    rerender(
      <NativeSkillTypeahead
        query="$deploy"
        skills={skills}
        selectedKey={nativeSkillSelectionKey(skills[0])}
        onHoverKey={onHoverKey}
        onSelect={onSelect}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /deploy-preview/i })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Codex skills' }), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(skills[0]);

    rerender(
      <NativeSkillTypeahead
        query=""
        skills={skills}
        selectedKey={nativeSkillSelectionKey(skills[0])}
        onHoverKey={onHoverKey}
        onSelect={onSelect}
        onRefresh={vi.fn()}
      />,
    );
    const listbox = screen.getByRole('listbox', { name: 'Codex skills' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(onHoverKey).toHaveBeenCalledWith(nativeSkillSelectionKey(skills[1]));
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(skills[1]);
    fireEvent.click(screen.getByRole('option', { name: /deploy-preview/i }));
    expect(onSelect).toHaveBeenLastCalledWith(skills[0]);
  });

  it('keeps mouse hover notifications to one update per active option', () => {
    const onHoverKey = vi.fn();
    renderPicker({ onHoverKey });

    const nextOption = screen.getByRole('option', { name: /review-diff/i });
    fireEvent.mouseMove(nextOption);
    fireEvent.mouseMove(nextOption);
    fireEvent.mouseMove(nextOption);

    expect(onHoverKey).toHaveBeenCalledOnce();
    expect(onHoverKey).toHaveBeenCalledWith(nativeSkillSelectionKey(skills[1]));
  });

  it('supports Home and End and keeps the active descendant on the available option', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    const listbox = screen.getByRole('listbox', { name: 'Codex skills' });
    const firstOption = screen.getByRole('option', { name: /deploy-preview/i });
    const lastAvailableOption = screen.getByRole('option', { name: /review-diff/i });

    fireEvent.keyDown(listbox, { key: 'End' });
    expect(lastAvailableOption.getAttribute('aria-selected')).toBe('true');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(lastAvailableOption.id);
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith(skills[1]);

    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(firstOption.getAttribute('aria-selected')).toBe('true');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(firstOption.id);
  });

  it('exposes move/select and accessible listbox identity for Composer key handling', () => {
    const ref = createRef<ComponentRef<typeof NativeSkillTypeahead>>();
    const onSelect = vi.fn();
    const onHoverKey = vi.fn();
    renderPicker({ ref, onSelect, onHoverKey });

    expect(ref.current?.getListboxId()).toBeTruthy();
    act(() => ref.current?.moveDown());
    expect(onHoverKey).toHaveBeenCalledWith(nativeSkillSelectionKey(skills[1]));
    expect(ref.current?.getActiveDescendantId()).toBeTruthy();
    act(() => ref.current?.selectCurrent());
    expect(onSelect).toHaveBeenCalledWith(skills[1]);
  });

  it('marks disabled skills unavailable and reports discovery errors with a refresh action', () => {
    const onRefresh = vi.fn();
    const onSelect = vi.fn();
    const errors: CodexSkillDiscoveryError[] = [
      {
        cwd: skills[1]!.cwd,
        path: skills[1]!.path,
        message: 'Permission denied',
      },
    ];
    renderPicker({ errors, onRefresh, onSelect });

    expect(
      screen
        .getByRole('option', { name: /disabled-skill.*unavailable/i })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    const erroredOption = screen.getByRole('option', { name: /review-diff.*unavailable/i });
    expect(erroredOption.getAttribute('aria-disabled')).toBe('true');
    expect(erroredOption.textContent).toContain('Permission denied');
    fireEvent.click(screen.getByRole('option', { name: /disabled-skill/i }));
    fireEvent.click(erroredOption);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('shows loading and list-level error states without claiming skills are ready', () => {
    const onRefresh = vi.fn();
    const { rerender } = renderPicker({ loading: true, onRefresh });
    expect(screen.getByRole('status').textContent).toMatch(/Loading skills/i);
    expect((screen.getByRole('button', { name: 'Refresh skills' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <NativeSkillTypeahead
        query=""
        skills={[]}
        loading={false}
        error="Codex skill discovery failed"
        onSelect={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Codex skill discovery failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
