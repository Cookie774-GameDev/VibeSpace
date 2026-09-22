import { render, screen } from '@testing-library/react';
import { AssistantRichText, parseAssistantBlocks, parseAssistantInline } from './AssistantRichText';

describe('AssistantRichText', () => {
  it('keeps prose scannable with headings, nested bullets, inline code, and safe links', () => {
    const source = [
      '# Build notes',
      '',
      'Ship the **small _change_** with `npm test`.',
      'Keep the second line intact.',
      '',
      '- inspect the receipt',
      '  - expand the details',
      '- verify the result',
      '',
      '[Open the docs](https://example.com/docs)',
    ].join('\n');

    const { container } = render(<AssistantRichText text={source} />);

    expect(screen.getByRole('heading', { name: 'Build notes' })).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByText('expand the details')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the docs' }).getAttribute('href')).toBe(
      'https://example.com/docs',
    );
    expect(container.querySelector('[data-depth="1"]')).toBeTruthy();
    expect(container.textContent).toContain('Keep the second line intact.');
  });

  it('renders code and existing diagram fences as bounded, scrollable cards', () => {
    const source = [
      '```ts',
      "const value = '<safe>';",
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      'A[Chat] --> B[Router]',
      '```',
    ].join('\n');

    const { container } = render(<AssistantRichText text={source} />);

    expect(container.querySelector('[data-assistant-code]')).toBeTruthy();
    expect(container.querySelector('[data-assistant-diagram]')).toBeTruthy();
    expect(screen.getByText("const value = '<safe>';" )).toBeTruthy();
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Router')).toBeTruthy();
    expect(screen.getByText('A → B')).toBeTruthy();
    expect(screen.getByText('Source · mermaid')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy diagram source' })).toBeTruthy();
  });

  it('does not invent diagram cards for ordinary prose and keeps HTML inert', () => {
    const { container } = render(<AssistantRichText text={'<script>alert(1)</script>\n\nplain text'} />);

    expect(container.querySelector('[data-assistant-diagram]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('plain text');
  });

  it('marks live output for the CSS shimmer without changing the source text', () => {
    const { container } = render(<AssistantRichText text="Streaming output" live />);
    const root = container.querySelector('[data-assistant-rich-text]');
    expect(root?.getAttribute('data-assistant-rich-text-live')).toBe('true');
    expect(root?.classList.contains('assistant-rich-text--live')).toBe(true);
    expect(root?.textContent).toContain('Streaming output');
  });

  it('supports tables and preserves the meaningful cell content', () => {
    const { container } = render(
      <AssistantRichText
        text={'| Layer | Responsibility |\n| --- | --- |\n| UI | Render the answer | extra column\n| CLI | Run the tools |'}
      />,
    );

    expect(container.querySelector('[data-assistant-table]')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Layer' })).toBeTruthy();
    expect(screen.getByText('Render the answer')).toBeTruthy();
    expect(screen.getByText('extra column')).toBeTruthy();
    expect(screen.getByText('Run the tools')).toBeTruthy();
  });

  it('keeps unsupported diagram syntax as source without a misleading partial preview', () => {
    const { container } = render(
      <AssistantRichText
        text={'~~~mermaid\nflowchart TD\nA[Chat] --> B[Router]\nnot valid diagram syntax @@@\n~~~'}
      />,
    );

    expect(container.querySelector('[data-assistant-diagram]')).toBeTruthy();
    expect(container.querySelector('.assistant-rich-text__diagram-preview')).toBeNull();
    expect(container.textContent).toContain('not valid diagram syntax @@@');
  });

  it('does not flatten Mermaid undirected, labelled, or subgraph edges into arrows', () => {
    const { container } = render(
      <AssistantRichText
        text={[
          '```mermaid',
          'graph TD',
          'A---B',
          'B -->|label| C',
          'subgraph grouped',
          'C --> D',
          'end',
          '```',
        ].join('\n')}
      />,
    );

    expect(container.querySelector('[data-assistant-diagram]')).toBeTruthy();
    expect(container.querySelector('.assistant-rich-text__diagram-preview')).toBeNull();
    expect(container.textContent).toContain('A---B');
    expect(container.textContent).toContain('B -->|label| C');
    expect(container.textContent).toContain('subgraph grouped');
  });
});

describe('assistant rich text parsing', () => {
  it('keeps unsupported links as visible text and records nested list depth', () => {
    const inline = parseAssistantInline('[bad](javascript:alert(1)) and **good**');
    expect(inline.some((token) => token.kind === 'link')).toBe(false);
    expect(inline.some((token) => token.kind === 'strong' && token.value === 'good')).toBe(true);

    const blocks = parseAssistantBlocks('- one\n    - two');
    expect(blocks).toEqual([
      {
        kind: 'list',
        items: [
          { depth: 0, marker: '-', ordered: false, text: 'one' },
          { depth: 2, marker: '-', ordered: false, text: 'two' },
        ],
      },
    ]);

    expect(parseAssistantBlocks('~~~js\nline with `backticks`\n~~~')).toEqual([
      { kind: 'code', language: 'js', value: 'line with `backticks`' },
    ]);
  });
});
