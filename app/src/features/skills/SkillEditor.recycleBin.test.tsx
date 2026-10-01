import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SkillManifest } from './loader';
import { SkillEditor } from './SkillEditor';

const recycleBinMocks = vi.hoisted(() => ({
  moveSkillToRecycleBin: vi.fn(),
}));

vi.mock('@/features/recycle-bin/recycleBinService', () => ({
  recycleBinService: recycleBinMocks,
}));

const customManifest: SkillManifest = {
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

describe('SkillEditor Recycle Bin deletion', () => {
  it('requires accessible confirmation before moving a custom skill', async () => {
    const onDeleted = vi.fn();
    recycleBinMocks.moveSkillToRecycleBin.mockResolvedValueOnce(undefined);
    render(<SkillEditor manifest={customManifest} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(recycleBinMocks.moveSkillToRecycleBin).not.toHaveBeenCalled();
    expect(
      screen.getByRole('alertdialog', { name: 'Move Custom Skill to Recycle Bin?' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Recycle Bin' }));
    await waitFor(() =>
      expect(recycleBinMocks.moveSkillToRecycleBin).toHaveBeenCalledWith('custom_skill'),
    );
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('does not expose a delete control for a protected preset', () => {
    render(
      <SkillEditor
        manifest={{
          ...customManifest,
          name: 'preset_skill',
          catalogId: 'preset_skill',
          title: 'Preset Skill',
          isPreset: true,
          source: 'builtin',
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore default' })).toBeTruthy();
  });
});
