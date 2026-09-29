import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Text } from '@/lib/fs';
import { MarkdownLibraryPanel } from './MarkdownLibraryPanel';
import { createMarkdownLibraryAuthority, type MarkdownLibrarySnapshot } from './runtime';

afterEach(cleanup);

function fixture() {
  const scope = { accountId: 'account-a', projectId: 'project-a', root: 'C:\\library' };
  let snapshot: MarkdownLibrarySnapshot = {
    generation: 0,
    documents: [],
    revisions: [],
    pendingRollback: null,
  };
  const files = new Map<string, string>();
  const authority = createMarkdownLibraryAuthority({
    filePort: {
      async scanMarkdown() {
        return [...files].map(([path, content]) => ({ path, content, modifiedAt: 1 }));
      },
      async readText({ path }) {
        return files.get(path) ?? null;
      },
      async compareAndWrite({ path, expectedSha256, content }) {
        const prior = files.get(path);
        const hash = prior === undefined ? null : await sha256Text(prior);
        if (hash !== expectedSha256) return false;
        files.set(path, content);
        return true;
      },
    },
    repository: {
      async readProjectIndex() {
        return snapshot;
      },
      async replaceProjectIndex({ expectedGeneration, next }) {
        if (snapshot.generation !== expectedGeneration) return false;
        snapshot = next;
        return true;
      },
    },
    now: () => 1000,
  });
  const openLibrary = vi.fn(async () => ({ scope, authority }));
  return { openLibrary, files };
}

describe('Markdown Library panel', () => {
  it('creates, searches, edits, inspects history, and reopens a saved document', async () => {
    const { openLibrary } = fixture();
    const props = {
      accountId: 'account-a',
      projectId: 'project-a',
      desktopAvailable: true,
      openLibrary,
    };
    const view = render(<MarkdownLibraryPanel {...props} />);
    const newButton = await screen.findByRole('button', { name: 'New Markdown' });
    await waitFor(() => expect((newButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(newButton);
    fireEvent.change(screen.getByLabelText('New Markdown title'), {
      target: { value: 'Release plan' },
    });
    fireEvent.change(screen.getByLabelText('New Markdown body'), {
      target: { value: 'Copper compass 682' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create document' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Markdown content') as HTMLTextAreaElement).value).toBe(
        '# Release plan\n\nCopper compass 682',
      ),
    );

    fireEvent.change(screen.getByLabelText('Search Markdown library'), {
      target: { value: 'compass' },
    });
    expect(await screen.findByRole('button', { name: /Release plan.*Revision 1/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Markdown content'), {
      target: { value: '# Release plan\n\nUpdated fact' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Markdown' }));
    await waitFor(() => expect(screen.getByText('Release plan · revision 2')).toBeTruthy());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'View revision 1' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View revision 1' }));
    expect(await screen.findByText(/Copper compass 682/)).toBeTruthy();

    view.unmount();
    render(<MarkdownLibraryPanel {...props} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Release plan.*Revision 2/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Release plan.*Revision 2/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Markdown content') as HTMLTextAreaElement).value).toBe(
        '# Release plan\n\nUpdated fact',
      ),
    );
  });
});
