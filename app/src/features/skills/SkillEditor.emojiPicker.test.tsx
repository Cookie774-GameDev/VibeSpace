import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillManifest } from './loader';
import { SkillEditor } from './SkillEditor';

const manifest: SkillManifest = {
  name: 'custom_skill',
  title: 'Custom Skill',
  kind: 'skill',
  body: 'Existing instructions',
  source: 'project',
  filePath: 'local/custom_skill.md',
  catalogId: 'custom_skill',
  isPreset: false,
  emoji: '🧭',
};

afterEach(cleanup);

describe('SkillEditor shared emoji picker', () => {
  it('preserves the current skill emoji and keeps extra VibeSpace icons behind plus', async () => {
    render(<SkillEditor manifest={manifest} />);

    expect(screen.getByLabelText('Current Skill emoji').textContent).toContain('🧭');
    expect(screen.getAllByRole('button', { name: /^Choose /u })).toHaveLength(5);
    expect(screen.queryByRole('dialog', { name: 'Choose Skill emoji' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open full Skill emoji picker' }));
    expect(await screen.findByRole('dialog', { name: 'Choose Skill emoji' })).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'Existing Skill emoji ✦' })).toBeTruthy();
  }, 10_000);
});
