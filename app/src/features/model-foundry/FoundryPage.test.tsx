import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FoundryPage } from './FoundryPage';
import { InMemoryStorageAdapter } from './localRepository';

const NOW = '2026-07-13T12:00:00.000Z';

function idFactory() {
  const counts = new Map<string, number>();
  return (kind: string) => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return `${kind}-${next}`;
  };
}

function renderFoundry(storage = new InMemoryStorageAdapter()) {
  const dependencies = { clock: () => NOW, idFactory: idFactory() };
  return {
    storage,
    dependencies,
    ...render(<FoundryPage storage={storage} dependencies={dependencies} />),
  };
}

describe('FoundryPage fixture vertical slice', () => {
  it('runs create, fixture training, evaluation, explicit promotion, and restart recovery', async () => {
    const view = renderFoundry();

    expect(screen.getByRole('heading', { name: 'Build Your Own AI' })).toBeTruthy();
    expect(screen.getByText(/fixture mode never trains weights/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    expect(screen.getByRole('heading', { name: 'VibeCoder' })).toBeTruthy();
    expect(screen.getByText('Project ready')).toBeTruthy();
    expect(screen.getByText('Spark · local Foundry unrestricted')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check this device' }));
    expect(await screen.findByText('Desktop hardware check unavailable in web mode.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Prepare approved fixture inputs' }));
    expect(screen.getByText('1 approved example')).toBeTruthy();
    expect(screen.getByText('Fixture Base · Apache-2.0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start fixture training' }));
    const jobRegion = screen.getByRole('region', { name: 'Training job' });
    expect(within(jobRegion).getByText('Queued')).toBeTruthy();

    for (const expectedState of ['Preparing', 'Training', 'Checkpointing', 'Completed']) {
      fireEvent.click(screen.getByRole('button', { name: 'Advance fixture job' }));
      expect(within(jobRegion).getByText(expectedState)).toBeTruthy();
    }
    expect(screen.getByText(/no model training or gpu work occurred/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run fixture evaluation' }));
    expect(screen.getByText('All gates passed')).toBeTruthy();
    expect(screen.getByText('0 safety failures')).toBeTruthy();
    expect(screen.getByText('Per-case evaluation evidence')).toBeTruthy();
    expect(screen.getByText('Hidden case')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Promote candidate' }));
    expect(screen.getByText('Current champion')).toBeTruthy();

    view.unmount();
    render(<FoundryPage storage={view.storage} dependencies={view.dependencies} />);
    expect(screen.getByRole('heading', { name: 'VibeCoder' })).toBeTruthy();
    expect(screen.getByText('Current champion')).toBeTruthy();
  }, 15_000);

  it('does not expose promotion before a complete passing evaluation', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare approved fixture inputs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture training' }));

    expect(screen.queryByRole('button', { name: 'Promote candidate' })).not.toBeTruthy();
  });

  it('persists an interrupted restart state and resumes it explicitly', () => {
    const view = renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare approved fixture inputs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start fixture training' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advance fixture job' }));
    view.unmount();

    const restarted = render(<FoundryPage storage={view.storage} dependencies={view.dependencies} />);
    expect(within(screen.getByRole('region', { name: 'Training job' })).getByText('Interrupted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume fixture job' }));
    expect(within(screen.getByRole('region', { name: 'Training job' })).getByText('Preparing')).toBeTruthy();
    restarted.unmount();

    render(<FoundryPage storage={view.storage} dependencies={view.dependencies} />);
    expect(within(screen.getByRole('region', { name: 'Training job' })).getByText('Interrupted')).toBeTruthy();
  });

  it('requires explicit license approval for a pinned real model download', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));

    expect(screen.getByText(/Revision a91318be/)).toBeTruthy();
    expect(screen.getByText('Real local mode · setup required')).toBeTruthy();
    expect(screen.queryByText(/Truthful simulation/)).not.toBeTruthy();
    expect(screen.getByText(/Remote model code stays disabled/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download and verify model' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    expect(screen.getByRole('button', { name: 'Download and verify model' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Prepare approved fixture inputs' })).not.toBeTruthy();
  });

  it('retains an earlier local specialist when creating another project', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));

    expect(screen.getByText(/2 saved specialists/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /VibeCoder/ })).toHaveLength(2);
  });

  it('keeps saved specialists available while creating another AI', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));

    expect(screen.getByText('Local specialist projects')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^VibeCoder\b/ }));
    expect(screen.getByRole('heading', { name: 'VibeCoder' })).toBeTruthy();
  });

  it('resets project-scoped creation state before starting another AI', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Dataset Studio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));

    expect(screen.getByText('Fixture mode · local only')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Dataset Studio' })).toBeTruthy();
  });

  it('restores the persisted base-model selection when reopening a project', () => {
    renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare approved fixture inputs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
    expect(screen.getByText('Real local mode · setup required')).toBeTruthy();

    const catalogEntries = screen.getAllByRole('button', { name: /^VibeCoder Review narrow coding changes/ });
    fireEvent.click(catalogEntries.at(-1)!);
    expect(screen.getByText('Fixture mode · local only')).toBeTruthy();
  });

  it('creates a custom specialist with governed language and forbidden action', () => {
    const view = renderFoundry();
    fireEvent.click(screen.getByRole('button', { name: 'Create custom AI' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Specialist name' }), { target: { value: 'Invoice Extractor' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Narrow task' }), { target: { value: 'Extract invoice totals from a local document.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Expected input' }), { target: { value: 'A local invoice document.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Expected output' }), { target: { value: 'A validated total record.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Hard constraint' }), { target: { value: 'Use only fields present in the document.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Output language' }), { target: { value: 'Spanish' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Forbidden action' }), { target: { value: 'invent totals' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create custom AI' }));

    expect(screen.getByRole('heading', { name: 'Invoice Extractor' })).toBeTruthy();
    expect(screen.getAllByText(/Extract invoice totals from a local document/).length).toBeGreaterThan(0);
    expect(JSON.parse(view.storage.getItem('vibespace.model-foundry.current') ?? '{}').snapshot.project.specialist.forbiddenBehavior).toContain('Never invent totals.');
  });
});
