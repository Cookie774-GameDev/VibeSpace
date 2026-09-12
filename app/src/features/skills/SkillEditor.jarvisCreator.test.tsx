import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  JARVIS_CREATOR_APPLY_SKILL_EVENT,
  type JarvisCreatorSkillDraft,
} from '@/features/jarvis-creator/contracts';
import { consumePendingJarvisCreatorStart } from '@/features/jarvis-creator/launcher';
import { useUIStore } from '@/stores/ui';
import type { SkillManifest } from './loader';
import { SkillEditor } from './SkillEditor';

const manifest: SkillManifest = {
  name: 'custom_skill',
  title: 'Custom Skill',
  description: 'Existing description',
  kind: 'skill',
  tools: [],
  body: 'Existing body',
  source: 'project',
  filePath: 'local/custom_skill.md',
  catalogId: 'custom_skill',
  isPreset: false,
  systemPromptAddendum: 'Existing runtime instructions',
  emoji: '✦',
  colorHue: 35,
};

describe('SkillEditor Jarvis creator integration', () => {
  it('opens the Inspector Jarvis creator from the current skill editor', () => {
    useUIStore.setState({ inspectorOpen: false });
    consumePendingJarvisCreatorStart();
    render(<SkillEditor manifest={manifest} />);

    fireEvent.click(screen.getByRole('button', { name: /Create with Jarvis/i }));

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(consumePendingJarvisCreatorStart()).toMatchObject({
      kind: 'skill',
      currentName: 'Custom Skill',
      currentDescription: 'Existing description',
    });
  });

  it('applies a Jarvis-generated skill draft into the editor without saving', async () => {
    render(<SkillEditor manifest={manifest} />);
    const draft: JarvisCreatorSkillDraft = {
      title: 'Polish Writer',
      description: 'Makes rough copy crisp.',
      tools: ['files', 'chat'],
      systemPromptAddendum: 'Rewrite copy with concise production polish.',
      body: '## Use\n\nUse this when copy feels rough.',
      emoji: '✨',
    };

    act(() => {
      window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_SKILL_EVENT, { detail: draft }));
    });

    await waitFor(() => expect(screen.getByPlaceholderText('Skill name')).toHaveProperty('value', 'Polish Writer'));
    expect(screen.getByPlaceholderText('Short description for /skills picker')).toHaveProperty('value', 'Makes rough copy crisp.');
    expect(screen.getByPlaceholderText('files, terminal, web')).toHaveProperty('value', 'files, chat');
    expect(screen.getByPlaceholderText(/Injected into chat/i)).toHaveProperty('value', 'Rewrite copy with concise production polish.');
    expect(screen.getByDisplayValue(/Use this when copy feels rough/i)).toBeTruthy();
  });
});
