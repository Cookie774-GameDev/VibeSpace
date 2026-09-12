import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextGalaxy, type ContextGalaxyNode } from './ContextGalaxy';

const nodes: ContextGalaxyNode[] = [
  {
    id: 'root',
    label: 'Workspace',
    description: 'Current Context workspace',
    parentId: null,
    groupId: 'workspace',
    depth: 0,
    order: 0,
    radius: 20,
  },
  {
    id: 'notes',
    label: 'Notes',
    description: 'Authored knowledge',
    parentId: 'root',
    groupId: 'notes',
    depth: 1,
    order: 0,
    radius: 14,
  },
];
const edges = [{ id: 'root-notes', from: 'root', to: 'notes' }];

describe('ContextGalaxy', () => {
  it('renders explicit 3D controls and accessible node details', () => {
    render(
      <ContextGalaxy
        nodes={nodes}
        edges={edges}
        selectedId="root"
        activityNodeIds={[]}
        onSelect={vi.fn()}
        webglAvailable
      />,
    );
    expect(screen.getByRole('button', { name: 'Use 3D galaxy' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Use 2D fallback' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Context galaxy' })).toBeTruthy();
    expect(screen.getByText('Current Context workspace')).toBeTruthy();
  });

  it('marks only nodes backed by real activity and disables pulses for reduced motion', () => {
    const rendered = render(
      <ContextGalaxy
        nodes={nodes}
        edges={edges}
        selectedId="notes"
        activityNodeIds={['notes']}
        onSelect={vi.fn()}
        webglAvailable
        reducedMotion
      />,
    );
    expect(
      screen.getByRole('button', { name: /Notes/ }).getAttribute('data-context-activity'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /Workspace/ }).getAttribute('data-context-activity'),
    ).toBe('false');
    expect(rendered.container.querySelector('canvas')?.getAttribute('data-animation-enabled')).toBe(
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use 2D fallback' }));
    expect(
      rendered.container
        .querySelector('[data-context-edge="root-notes"]')
        ?.getAttribute('data-context-activity'),
    ).toBe('true');
  });

  it('supports keyboard node selection and direct 2D fallback', () => {
    const onSelect = vi.fn();
    render(
      <ContextGalaxy
        nodes={nodes}
        edges={edges}
        selectedId="root"
        activityNodeIds={[]}
        onSelect={onSelect}
        webglAvailable={false}
      />,
    );
    expect(screen.getByTestId('context-galaxy-2d')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Context galaxy' }), {
      key: 'ArrowDown',
    });
    expect(onSelect).toHaveBeenCalledWith('notes');
  });

  it('selects a visible 3D node without treating orbit drags as clicks', () => {
    const onSelect = vi.fn();
    render(
      <ContextGalaxy
        nodes={nodes}
        edges={edges}
        selectedId={null}
        activityNodeIds={[]}
        onSelect={onSelect}
        webglAvailable
      />,
    );
    const region = screen.getByRole('region', { name: 'Context galaxy' });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => undefined,
    });
    fireEvent.pointerDown(region, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerUp(region, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    expect(onSelect).toHaveBeenCalledWith('root');

    onSelect.mockClear();
    fireEvent.pointerDown(region, { pointerId: 2, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(region, { pointerId: 2, clientX: 460, clientY: 300, button: 0 });
    fireEvent.pointerUp(region, { pointerId: 2, clientX: 460, clientY: 300, button: 0 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('uses bounded compact presentation without a heavy border', () => {
    render(
      <ContextGalaxy
        nodes={nodes}
        edges={edges}
        selectedId="root"
        activityNodeIds={[]}
        onSelect={vi.fn()}
        compact
        webglAvailable={false}
      />,
    );
    const region = screen.getByRole('region', { name: 'Compact Context galaxy' });
    expect(region.getAttribute('data-context-galaxy-mode')).toBe('compact');
    expect(region.className).toContain('border-t');
    expect(region.className).not.toContain('border-2');
  });
});
