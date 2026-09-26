import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { getUnifiedSkillManifests } from './skillCatalog';
import { SkillEditor } from './SkillEditor';
import { readSkillsStore, resetSkillsStoreForTests } from './skillsStore';

describe('SkillEditor saved instructions and preview', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ localUserId: 'skill-preview-test', cloudSession: null });
    resetSkillsStoreForTests();
  });

  it('updates a generated preset body and preview when runtime instructions change, then saves both', () => {
    const manifest = getUnifiedSkillManifests().find((skill) => skill.catalogId === 'analyze')!;
    const originalInstructions = manifest.systemPromptAddendum!;
    const { container, rerender } = render(<SkillEditor manifest={manifest} />);
    const instructions = screen.getByPlaceholderText(/Injected into chat/i) as HTMLTextAreaElement;
    const body = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement;

    fireEvent.change(instructions, { target: { value: 'Use the new X21 instructions.' } });
    expect(body.value).toContain('Use the new X21 instructions.');
    expect(body.value).not.toContain(originalInstructions);

    const previewTab = screen.getByRole('tab', { name: 'Preview' });
    fireEvent.mouseDown(previewTab, { button: 0, ctrlKey: false });
    fireEvent.click(previewTab);
    expect(
      container.querySelector('[data-monochrome-surface="skill-preview"]')?.textContent,
    ).toContain('Use the new X21 instructions.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(readSkillsStore().presetOverrides.analyze).toMatchObject({
      systemPromptAddendum: 'Use the new X21 instructions.',
      body: expect.stringContaining('Use the new X21 instructions.'),
    });
    const saved = getUnifiedSkillManifests().find((skill) => skill.catalogId === 'analyze')!;
    rerender(<SkillEditor manifest={saved} />);
    expect(instructions.value).toBe('Use the new X21 instructions.');
    expect(body.value).toContain('Use the new X21 instructions.');
  });

  it('keeps hand-written Markdown and adds updated runtime instructions to its body and preview', () => {
    const id = readSkillsStore().addCustomSkill({ name: 'Custom', description: 'Custom notes' });
    readSkillsStore().updateCustomSkill(id, { body: '# Hand-written\n\nKeep this text.' });
    const manifest = getUnifiedSkillManifests().find((skill) => skill.catalogId === id)!;
    const { container } = render(<SkillEditor manifest={manifest} />);
    const instructions = screen.getByPlaceholderText(/Injected into chat/i) as HTMLTextAreaElement;
    const body = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement;

    fireEvent.change(instructions, { target: { value: 'New runtime instruction.' } });
    expect(body.value).toContain('# Hand-written\n\nKeep this text.');
    expect(body.value).toContain('## Runtime instructions\n\nNew runtime instruction.');
    const previewTab = screen.getByRole('tab', { name: 'Preview' });
    fireEvent.mouseDown(previewTab, { button: 0, ctrlKey: false });
    fireEvent.click(previewTab);
    expect(
      container.querySelector('[data-monochrome-surface="skill-preview"]')?.textContent,
    ).toContain('New runtime instruction.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(readSkillsStore().getCustomSkill(id)).toMatchObject({
      systemPromptAddendum: 'New runtime instruction.',
      body: expect.stringContaining('## Runtime instructions\n\nNew runtime instruction.'),
    });
  });
});
