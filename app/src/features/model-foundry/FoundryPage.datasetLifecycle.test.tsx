import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FoundryPage } from './FoundryPage';
import { InMemoryStorageAdapter, VersionedFixtureRepository } from './localRepository';
import { FOUNDRY_DRAFT_REPOSITORY_PREFIX } from './draftDeletion';
import * as dataset from './datasetStudio';

it('does not restore the old project when a real dataset hash build finishes after creating another draft', async () => {
  const counts: Record<string, number> = {};
  const storage = new InMemoryStorageAdapter();
  render(<FoundryPage storage={storage} dependencies={{ clock: () => '2026-10-06T21:30:00Z',
    idFactory: (kind) => `${kind}-${counts[kind] = (counts[kind] ?? 0) + 1}` }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Dataset Studio' }));
  fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Old project seed.' } });
  fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: 'Old target.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add approved example' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hashSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await held; return digest(...args); });
  const buildSpy = vi.spyOn(dataset, 'buildDatasetVersion');
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(hashSpy).toHaveBeenCalled());
    const build = buildSpy.mock.results[0]!.value as Promise<dataset.DatasetBuildResult>;
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    await act(async () => { release(); await build; });
    expect(screen.queryByText('Old project seed.')).toBeNull();
    expect(screen.getByText('Awaiting approved inputs.')).toBeTruthy();
    const saved = new VersionedFixtureRepository(storage, FOUNDRY_DRAFT_REPOSITORY_PREFIX, () => 'test-read').load();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value?.project.id).toBe('project-2');
    expect(saved.value?.datasetVersion).toBeUndefined();
  } finally { release(); vi.restoreAllMocks(); }
});
