import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeIndicator } from './ModeIndicator';
import {
  readAgentApprovalMode,
  readPermissionAccess,
  setAgentApprovalMode,
  setApproveAllForRun,
  setPermissionAccess,
} from './permissionAccessStore';

describe('ModeIndicator', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('waits for an explicit Agent profile and persists Full access', async () => {
    const onSelectMode = vi.fn();
    render(<ModeIndicator mode="agent" chatId="chat-full" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByRole('button', { name: /Agent Mode/i }));
    fireEvent.click(screen.getByRole('option', { name: /Agent Mode/i }));
    expect(onSelectMode).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: /Agent access/i })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('option', { name: /Full access/i }));
    expect(readAgentApprovalMode('chat-full')).toBe('full');
    expect(onSelectMode).toHaveBeenCalledWith('agent');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('visually marks the selected Agent access profile', () => {
    setAgentApprovalMode('chat-profile', 'review');
    render(<ModeIndicator mode="agent" chatId="chat-profile" onSelectMode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Agent Mode/i }));
    fireEvent.click(screen.getByRole('option', { name: /Agent Mode/i }));

    const full = screen.getByRole('option', { name: /Full access/i });
    const review = screen.getByRole('option', { name: /Review risky actions/i });
    expect(full.getAttribute('aria-selected')).toBe('false');
    expect(review.getAttribute('aria-selected')).toBe('true');
    expect(full.className).toContain('border-transparent');
    expect(review.className).toContain('border-accent-cyan/45');
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(review.textContent).toContain('Active');
  });

  it('offers only Agent, Plan, and Ask, then applies Plan read-only access and closes', async () => {
    const onSelectMode = vi.fn();
    setPermissionAccess('chat-plan', 'full');
    setApproveAllForRun('chat-plan', true);
    render(<ModeIndicator mode="agent" chatId="chat-plan" onSelectMode={onSelectMode} />);

    expect(screen.getByRole('button', { name: /Agent Mode/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Agent Mode/i }));

    expect(screen.getByRole('listbox', { name: /Chat modes/i })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('Plan Mode')).toBeTruthy();
    expect(screen.getByText('Ask Mode')).toBeTruthy();
    expect(screen.queryByText('Read Only')).toBeNull();
    expect(screen.queryByText('Write Access')).toBeNull();
    expect(screen.queryByText('Full Access')).toBeNull();
    expect(screen.queryByText(/Approve All for This Run/i)).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /Plan Mode/i }));
    expect(onSelectMode).toHaveBeenCalledWith('plan');
    expect(readPermissionAccess('chat-plan')).toEqual({ access: 'read', approveAll: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('normalizes active Ask to read-only and clears stale approve-all', async () => {
    setPermissionAccess('chat-ask', 'full');
    setApproveAllForRun('chat-ask', true);
    render(<ModeIndicator mode="ask" chatId="chat-ask" onSelectMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask Mode/i }));
    const askOption = screen.getByRole('option', { name: /Ask Mode/i });
    expect(askOption.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(askOption);

    expect(readPermissionAccess('chat-ask')).toEqual({ access: 'read', approveAll: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('normalizes Agent to full access and clears stale approve-all', async () => {
    setPermissionAccess('chat-agent', 'read');
    setApproveAllForRun('chat-agent', true);
    render(<ModeIndicator mode="plan" chatId="chat-agent" onSelectMode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Plan Mode/i }));
    fireEvent.click(screen.getByRole('option', { name: /Agent Mode/i }));
    fireEvent.click(screen.getByRole('option', { name: /Review risky actions/i }));

    expect(readPermissionAccess('chat-agent')).toEqual({ access: 'full', approveAll: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('focuses the selected mode and roves without changing selection until Enter', async () => {
    const onSelectMode = vi.fn();
    render(<ModeIndicator mode="ask" onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask Mode/i }));

    const agent = screen.getByRole('option', { name: /Agent Mode/i });
    const plan = screen.getByRole('option', { name: /Plan Mode/i });
    const ask = screen.getByRole('option', { name: /Ask Mode/i });
    await waitFor(() => expect(document.activeElement).toBe(ask));

    fireEvent.keyDown(ask, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(agent);
    expect(ask.getAttribute('aria-selected')).toBe('true');
    expect(agent.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(agent, { key: 'End' });
    expect(document.activeElement).toBe(ask);
    fireEvent.keyDown(ask, { key: 'Home' });
    expect(document.activeElement).toBe(agent);
    fireEvent.keyDown(agent, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ask);
    fireEvent.keyDown(ask, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(plan);

    fireEvent.keyDown(plan, { key: 'Enter' });
    expect(onSelectMode).toHaveBeenCalledWith('plan');
  });

  it('activates with Space, closes, and returns focus to the trigger', async () => {
    const onSelectMode = vi.fn();
    render(<ModeIndicator mode="agent" onSelectMode={onSelectMode} />);
    const trigger = screen.getByRole('button', { name: /Agent Mode/i });
    fireEvent.click(trigger);
    const agent = screen.getByRole('option', { name: /Agent Mode/i });
    await waitFor(() => expect(document.activeElement).toBe(agent));

    fireEvent.keyDown(agent, { key: 'ArrowDown' });
    const plan = screen.getByRole('option', { name: /Plan Mode/i });
    expect(document.activeElement).toBe(plan);
    fireEvent.keyDown(plan, { key: ' ' });
    expect(onSelectMode).toHaveBeenCalledWith('plan');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('removes closed content and restores focus when the exit animation never finishes', async () => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const computedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const styles = nativeGetComputedStyle(element);
      if (!(element instanceof HTMLElement) || element.getAttribute('role') !== 'dialog') {
        return styles;
      }
      return new Proxy(styles, {
        get(target, property, receiver) {
          if (property === 'animationName') {
            if (
              element.dataset.state === 'closed' &&
              element.classList.contains('data-[state=closed]:!animate-none')
            ) {
              return 'none';
            }
            return element.dataset.state === 'closed' ? 'mode-fade-out' : 'mode-scale-in';
          }
          if (property === 'display') return 'block';
          return Reflect.get(target, property, receiver);
        },
      });
    });

    try {
      render(<ModeIndicator mode="agent" onSelectMode={vi.fn()} />);
      const trigger = screen.getByRole('button', { name: /Agent Mode/i });
      fireEvent.click(trigger);
      const agent = screen.getByRole('option', { name: /Agent Mode/i });
      await waitFor(() => expect(document.activeElement).toBe(agent));

      fireEvent.keyDown(agent, { key: 'Escape' });

      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 500 });
      expect(document.activeElement).toBe(trigger);
    } finally {
      computedStyle.mockRestore();
    }
  });
});
