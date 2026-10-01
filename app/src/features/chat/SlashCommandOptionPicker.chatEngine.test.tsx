import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_ENGINE_OPTIONS } from '@/features/browser-chat/chatEngineTransition';
import {
  SlashCommandOptionPicker,
  type SlashCommandOptionPickerRef,
} from './SlashCommandOptionPicker';

describe('/chat engine option picker', () => {
  afterEach(cleanup);

  it('supports keyboard navigation and selection across the shared engine choices', () => {
    const ref = React.createRef<SlashCommandOptionPickerRef>();
    const onSelect = vi.fn();

    function Harness() {
      const [selectedId, setSelectedId] = React.useState('native');
      return (
        <SlashCommandOptionPicker
          ref={ref}
          commandLabel="chat"
          options={[...CHAT_ENGINE_OPTIONS]}
          selectedId={selectedId}
          query=""
          onHoverId={setSelectedId}
          onSelect={onSelect}
        />
      );
    }

    render(<Harness />);

    act(() => ref.current?.moveDown());
    act(() => ref.current?.selectCurrent());
    expect(onSelect).toHaveBeenCalledWith(CHAT_ENGINE_OPTIONS[1]);
  });
});
