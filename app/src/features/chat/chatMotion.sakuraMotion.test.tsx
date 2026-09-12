import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { InputToken } from './InputToken';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';

const motionProbe = vi.hoisted(() => ({
  layoutInputs: [] as unknown[],
  layoutTransitions: [] as unknown[],
  legacyTransitions: [] as unknown[],
  renderedTransitions: [] as unknown[],
  useLegacyTransition: false,
  useReducedTransition: false,
  themedLayoutTransition: { duration: 0 } as const,
  themedTransition: { duration: 0.123, ease: 'linear' } as const,
}));

vi.mock('@/features/appearance/themeMotion', () => ({
  useThemeLayoutTransition: (legacyTransition: unknown) => {
    motionProbe.layoutTransitions.push(legacyTransition);
    return motionProbe.themedLayoutTransition;
  },
  useThemeMotionLayout: (legacyLayout: unknown) => {
    motionProbe.layoutInputs.push(legacyLayout);
    return false;
  },
  useThemeMotionTransition: (legacyTransition: unknown) => {
    motionProbe.legacyTransitions.push(legacyTransition);
    if (motionProbe.useReducedTransition) return { duration: 0 } as const;
    if (motionProbe.useLegacyTransition) return legacyTransition;
    return motionProbe.themedTransition;
  },
}));

vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const motionElement = (tag: 'button' | 'div' | 'span') =>
    ReactModule.forwardRef<HTMLElement, Record<string, unknown>>(
      (
        {
          animate: _animate,
          children,
          exit: _exit,
          initial: _initial,
          layout,
          transition,
          ...props
        },
        ref,
      ) => {
        motionProbe.renderedTransitions.push(transition);
        return ReactModule.createElement(
          tag,
          {
            ...props,
            ref,
            'data-motion-layout': String(layout),
            'data-motion-transition': JSON.stringify(transition),
          },
          children as React.ReactNode,
        );
      },
    );

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      button: motionElement('button'),
      div: motionElement('div'),
      span: motionElement('span'),
    },
  };
});

const themedTransitionText = JSON.stringify(motionProbe.themedTransition);

describe('Chat Sakura Motion consumers', () => {
  beforeEach(() => {
    motionProbe.layoutInputs.length = 0;
    motionProbe.layoutTransitions.length = 0;
    motionProbe.legacyTransitions.length = 0;
    motionProbe.renderedTransitions.length = 0;
    motionProbe.useLegacyTransition = false;
    motionProbe.useReducedTransition = false;
  });

  it('routes MessageBubble through the shared policy with its exact legacy transition', () => {
    const message = {
      id: 'message-1',
      chat_id: 'chat-1',
      role: 'system',
      parts: [{ kind: 'text', text: 'System notice' }],
      created_at: 1,
      updated_at: 1,
    } as Message;

    const rendered = render(<MessageBubble message={message} />);

    expect(screen.getByText('System notice')).toBeTruthy();
    expect(motionProbe.legacyTransitions).toEqual([
      { type: 'spring', stiffness: 400, damping: 30, mass: 0.8 },
    ]);
    expect(motionProbe.layoutInputs).toEqual([true]);
    expect(rendered.container.querySelector('[data-motion-layout="false"]')).toBeTruthy();
    expect(
      rendered.container.querySelector(`[data-motion-transition='${themedTransitionText}']`),
    ).toBeTruthy();
  });

  it('routes InputToken through the shared policy without changing its accessible remove control', () => {
    const onRemove = vi.fn();
    const rendered = render(<InputToken type="agent" label="@builder" onRemove={onRemove} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove @builder' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(motionProbe.legacyTransitions).toEqual([
      { type: 'spring', stiffness: 520, damping: 26, mass: 0.7 },
    ]);
    expect(motionProbe.renderedTransitions.at(-1)).toEqual({
      ...motionProbe.themedTransition,
      filter: { type: 'tween', duration: 0.18, ease: 'easeOut' },
    });
  });

  it('keeps the spring motion but gives blur a non-overshooting tween', () => {
    motionProbe.useLegacyTransition = true;

    render(<InputToken type="command" label="/mode" />);

    expect(motionProbe.renderedTransitions.at(-1)).toEqual({
      type: 'spring',
      stiffness: 520,
      damping: 26,
      mass: 0.7,
      filter: { type: 'tween', duration: 0.18, ease: 'easeOut' },
    });
  });

  it('keeps the blur transition disabled when reduced motion is active', () => {
    motionProbe.useReducedTransition = true;

    render(<InputToken type="command" label="/mode" />);

    expect(motionProbe.renderedTransitions.at(-1)).toEqual({
      duration: 0,
      filter: { duration: 0 },
    });
  });

  it('routes both ToolCallCard expansion branches through the shared policy', () => {
    const fileCard = render(
      <ToolCallCard
        call={{
          kind: 'tool_call',
          call_id: 'call-file',
          tool: 'files.write',
          args: { path: 'notes.md', content: 'hello' },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit.*notes\.md/i }));
    expect(
      fileCard.container.querySelector(
        `[data-motion-transition='${JSON.stringify(motionProbe.themedLayoutTransition)}']`,
      ),
    ).toBeTruthy();
    fileCard.unmount();

    const shellCard = render(
      <ToolCallCard
        call={{
          kind: 'tool_call',
          call_id: 'call-shell',
          tool: 'shell',
          args: { command: 'echo hello' },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /shell/i }));
    expect(
      shellCard.container.querySelector(
        `[data-motion-transition='${JSON.stringify(motionProbe.themedLayoutTransition)}']`,
      ),
    ).toBeTruthy();
    expect(motionProbe.legacyTransitions).toEqual([]);
    expect(motionProbe.layoutTransitions.length).toBeGreaterThanOrEqual(2);
    for (const legacyTransition of motionProbe.layoutTransitions) {
      expect(legacyTransition).toEqual({
        type: 'spring',
        stiffness: 400,
        damping: 30,
        mass: 0.8,
      });
    }
  });
});

describe('owned Sakura Motion source boundary', () => {
  it('contains no raw explicit spring after every owned consumer is routed', async () => {
    const sources = await Promise.all(
      [
        'src/features/council/AgentPanel.tsx',
        'src/features/jarvis-interaction/ModeIndicator.tsx',
        'src/features/chat/MessageBubble.tsx',
        'src/features/chat/InputToken.tsx',
        'src/features/chat/ToolCallCard.tsx',
        'src/features/voice/VoiceCaption.tsx',
        'src/features/tasks/TaskCard.tsx',
        'src/features/tasks/DraftTaskList.tsx',
      ].map((path) => readFile(resolve(process.cwd(), path), 'utf8')),
    );

    expect(sources.join('\n')).not.toMatch(/type:\s*['"]spring['"]/);
    expect(sources.join('\n')).not.toMatch(/\n\s+layout\s*\n/);
  });
});
