import { describe, expect, it } from 'vitest';
import { createTerminalWebglBudget } from './terminalWebglBudget';

describe('terminal WebGL budget', () => {
  it('limits active contexts and makes released slots reusable', () => {
    const budget = createTerminalWebglBudget(2);
    const first = budget.acquire();
    const second = budget.acquire();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(budget.acquire()).toBeNull();

    first?.release();
    const replacement = budget.acquire();
    expect(replacement).not.toBeNull();
    expect(budget.active()).toBe(2);

    first?.release();
    second?.release();
    replacement?.release();
    expect(budget.active()).toBe(0);
  });
});
