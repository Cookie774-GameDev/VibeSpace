import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CouncilWorkflowPage } from './CouncilWorkflowPage';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ flatOptions: [] }),
}));
vi.mock('@/features/context/contextPersistence', () => ({
  loadPersistedContextMaps: async () => [],
}));
vi.mock('./workflowProduction', () => ({
  councilRunKey: () => 'run',
  captureCouncilContext: vi.fn(),
  councilWorkflow: { isActive: () => false, recover: vi.fn(), run: vi.fn(), cancel: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: { chats: { get: vi.fn() }, settings: { get: vi.fn() } } }));

afterEach(cleanup);
describe('Council workflow setup', () => {
  it('requires explicit context and two configured routes before enabling execution', () => {
    render(<CouncilWorkflowPage chatId="chat-1" />);
    expect(
      (screen.getByRole('button', { name: 'Run Council' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Council request'), {
      target: { value: 'Compare approaches' },
    });
    expect(
      (screen.getByRole('button', { name: 'Run Council' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByLabelText('Context Map')).toBeTruthy();
    expect(screen.getByLabelText('Perspective 1 model route')).toBeTruthy();
    expect(screen.getByLabelText('Perspective 2 model route')).toBeTruthy();
  });
});
