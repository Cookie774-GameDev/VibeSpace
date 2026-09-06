import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ThemedSelect } from './themed-select';

it('opens a themed list and selects the exact option with keyboard navigation', () => {
  const change = vi.fn();
  render(
    <ThemedSelect
      label="Chat"
      value="a"
      options={[
        { value: 'a', label: 'First' },
        { value: 'b', label: 'Second' },
      ]}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Chat' }));
  const first = screen.getByRole('option', { name: 'First' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Second' }));
  fireEvent.click(screen.getByRole('option', { name: 'Second' }));
  expect(change).toHaveBeenCalledWith('b');
  expect(screen.queryByRole('listbox')).toBeNull();
});
