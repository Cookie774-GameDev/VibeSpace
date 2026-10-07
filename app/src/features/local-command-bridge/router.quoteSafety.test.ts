import { describe, expect, it } from 'vitest';
import { routeLocalCommand } from './router';
import { DIRECT_COMMANDS } from './registry';
import { canRunLocalCommandWithoutModel, requiresLocalCommandPreflight } from './preModelBridge';

describe('local commands stay inert inside ordinary single quotations', () => {
  it.each([
    '"open settings"',
    '“open settings”',
    '`open settings`',
    "'open settings'",
    '‘open settings’',
    "'open settings; play music'",
    '‘open settings; play music’',
    "'we don't need that. open settings'",
    '‘we don’t need that. open settings’',
    "'the worker's note: open settings; play music'",
    '‘the worker’s note: open settings; play music’',
    "'open settings",
    '‘open settings',
    "'the workers' notes; open settings'",
    '‘the workers’ notes; open settings’',
  ])('does not admit quoted text as a local action: %s', (text) => {
    expect(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
    expect(canRunLocalCommandWithoutModel(text)).toBe(false);
  });

  it.each([
    "'open settings'; open a Codex terminal",
    '‘open settings’; open a Codex terminal',
    "'the worker's note: open settings'; open a Codex terminal",
    '‘the worker’s note: open settings’; open a Codex terminal',
    '“open settings”; open a Codex terminal',
  ])('preserves a genuine command outside the quotation: %s', (text) => {
    const result = routeLocalCommand(text);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ id: 'terminal.open', slots: { provider: 'codex' } });
    expect(result.commands[0].source).toBe('open a Codex terminal');
    expect(result.commands[0].sourceStart).toBe(text.indexOf('open a Codex terminal'));
    expect(requiresLocalCommandPreflight(text)).toBe(true);
    expect(canRunLocalCommandWithoutModel(text)).toBe(false);
  });

  it.each(['open settings', 'please open settings', `open 'settings'`, 'open “settings”'])(
    'keeps the supported positive command: %s', (text) => {
      expect(routeLocalCommand(text).commands).toEqual([
        expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
      ]);
      expect(canRunLocalCommandWithoutModel(text)).toBe(true);
    },
  );

  it.each(["don't open settings", 'don’t open settings', "please don't open settings"])(
    'retains ordinary apostrophe negation: %s', (text) => {
      expect(routeLocalCommand(text).commands).toEqual([]);
      expect(requiresLocalCommandPreflight(text)).toBe(false);
    },
  );

  it.each(["Review the workers' notes; open settings", 'Review the workers’ notes; open settings'])(
    'does not treat an ordinary plural possessive as an opening quote: %s', (text) => {
      const result = routeLocalCommand(text);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({ id: 'page.open', slots: { route: 'settings' } });
      expect(result.commands[0].source).toBe('open settings');
    },
  );

});


const supported = [
  ['new chat', 'chat.new'],
  ['next song', 'music.next'],
  ['previous song', 'music.previous'],
  ['list terminals', 'terminal.list'],
  ['mute music', 'music.mute'],
] as const;

it.each(['please "next song"', 'could you “previous song”', 'please `mute music`'])(
  'keeps a quoted direct alias inert after a polite wrapper: %s', (text) => {
    expect(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
  },
);

it.each([
  ['please next song', 'music.next'],
  ['next "song"', 'music.next'],
  ['previous “song”', 'music.previous'],
  ['mute `music`', 'music.mute'],
])('preserves the outside direct-alias action in %s', (text, id) => {
  expect(routeLocalCommand(text).commands).toEqual([expect.objectContaining({ id })]);
  expect(requiresLocalCommandPreflight(text)).toBe(true);
});

describe('independent quoted direct-alias authority', () => {
  it.each(supported)('establishes actual registry support for the unquoted alias %s', (text, id) => {
    expect(DIRECT_COMMANDS.find((entry) => entry.id === id)?.aliases).toContain(text);
    expect(routeLocalCommand(text).commands).toEqual([expect.objectContaining({ id })]);
    expect(requiresLocalCommandPreflight(text)).toBe(id.startsWith('music.'));
  });

  for (const [open, close] of [['"', '"'], ['`', '`'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
    it.each(supported)(`keeps ${open}%s${close} inert despite a matching direct alias`, (text) => {
      const quoted = `${open}${text}${close}`;
      expect.soft(routeLocalCommand(quoted).commands).toEqual([]);
      expect.soft(requiresLocalCommandPreflight(quoted)).toBe(false);
      expect(canRunLocalCommandWithoutModel(quoted)).toBe(false);
    });
  }

  it.each([
    '"open settings\\"; play music',
    '"the worker said \\"open settings\\"; play music"',
    '`open settings; play music',
    "'don't open settings; play music'",
    '‘don’t open settings; play music’',
  ])('keeps escaped or unclosed quoted actions inert: %s', (text) => {
    expect(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
  });

  it.each(['"next song"; open settings', '`new chat`; open settings', '“mute music”; open settings'])(
    'admits only the outside command in %s', (text) => {
      expect(routeLocalCommand(text).commands).toEqual([
        expect.objectContaining({ id: 'page.open', source: 'open settings', sourceStart: text.indexOf('open settings') }),
      ]);
    },
  );

  it.each(["open 'settings'", 'open “settings”', 'open `settings`'])(
    'retains the positive quoted object %s', (text) => {
      expect(routeLocalCommand(text).commands).toEqual([
        expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
      ]);
    },
  );
});


it('establishes the existing harmless-typo control', () => {
  expect(routeLocalCommand('opne settings').commands).toEqual([
    expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
  ]);
  expect(requiresLocalCommandPreflight('opne settings')).toBe(true);
});

it('keeps the complete quoted typo inert', () => {
  expect(routeLocalCommand('"opne settings"').commands).toEqual([]);
});

it.each(['"opne settings";', '“opne settings”.', '`opne settings`!'])(
  'does not grant quoted typo authority through punctuation: %s', (text) => {
    expect.soft(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
  },
);

it('admits only an outside command after a quoted supported typo', () => {
  const text = '"opne settings"; play music';
  expect(routeLocalCommand(text).commands).toEqual([
    expect.objectContaining({ id: 'music.play', source: 'play music', sourceStart: text.indexOf('play music') }),
  ]);
});

it.each(['please "opne settings";', 'could you “opne settings”.', 'please `opne settings`!'])(
  'keeps a supported typo quoted after a polite wrapper: %s', (text) => {
    expect(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
  },
);

it.each(['please opne settings', 'opne "settings"', 'opne `settings`'])(
  'retains an outside supported typo action in %s', (text) => {
    expect(routeLocalCommand(text).commands).toEqual([
      expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
    ]);
    expect(requiresLocalCommandPreflight(text)).toBe(true);
  },
);


const prefix = 'please '.repeat(40);
it.each(['open settings', 'opne settings', 'open "settings"'])(
  'establishes the supported unquoted action after a long polite prefix: %s', (command) => {
    const text = prefix + command;
    expect(routeLocalCommand(text).commands).toEqual([
      expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
    ]);
    expect(requiresLocalCommandPreflight(text)).toBe(true);
  },
);

it.each(['"open settings";', '“opne settings”.', '`next song`!'])(
  'keeps a quoted command inert beyond the preliminary preview: %s', (command) => {
    const text = prefix + command;
    expect.soft(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
  },
);

it.each(['before you finish ', 'once that’s done ', 'could you '])(
  'keeps corrected action positions through mixed long wrappers: %s', (wrapper) => {
    const lead = (wrapper + 'please ').repeat(24);
    const quoted = lead + '“opne settings”;';
    expect(routeLocalCommand(quoted).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(quoted)).toBe(false);
    const current = lead + 'opne "settings"';
    expect(routeLocalCommand(current).commands).toEqual([
      expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
    ]);
    expect(requiresLocalCommandPreflight(current)).toBe(true);
  },
);

it('preserves the exact outside-command offset after a long wrapped quotation', () => {
  const text = prefix + '"opne settings"; open settings';
  expect(routeLocalCommand(text).commands).toEqual([
    expect.objectContaining({ id: 'page.open', source: 'open settings', sourceStart: text.lastIndexOf('open settings') }),
  ]);
});

const matrixPrefixes = [
  '', 'please '.repeat(31), 'please '.repeat(31) + '  ',
  'please '.repeat(31) + '   ', 'please '.repeat(31) + '    ',
  'please '.repeat(32), 'please '.repeat(40),
  'İ want you to '.repeat(15), 'İ want you to '.repeat(16), 'İ want you to '.repeat(20),
];
const matrixQuotes = [
  { style: 'straight-double', open: '"', close: '"' },
  { style: 'curly-double', open: '“', close: '”' },
  { style: 'backtick', open: '`', close: '`' },
  { style: 'straight-single', open: "'", close: "'" },
  { style: 'curly-single', open: '‘', close: '’' },
];
const matrixCommands = [
  { command: 'open settings', id: 'page.open' },
  { command: 'opne settings', id: 'page.open' },
  ...supported.map(([command, id]) => ({ command, id })),
];
const quotedMatrix = matrixPrefixes.flatMap((lead) => matrixCommands.flatMap(({ command }) =>
  matrixQuotes.flatMap(({ style, open, close }) => ['', ';', '.', '!'].map((punctuation) => ({
    command, style, prefixStyle: lead.includes('İ') ? 'expanding-case' : 'ordinary', prefixLength: lead.length, punctuation,
    text: lead + open + command + close + punctuation,
  }))),
));

it.each(quotedMatrix)(
  'quote matrix rejects $command/$style/$prefixStyle/prefix=$prefixLength/trailer=$punctuation', ({ text }) => {
    expect(routeLocalCommand(text).commands).toEqual([]);
    expect(requiresLocalCommandPreflight(text)).toBe(false);
    expect(canRunLocalCommandWithoutModel(text)).toBe(false);
  },
);

it.each(matrixPrefixes.flatMap((lead) => matrixCommands.map(({ command, id }) => ({
  text: lead + command, command, id, prefixStyle: lead.includes('İ') ? 'expanding-case' : 'ordinary', prefixLength: lead.length,
}))))('quote matrix retains unquoted $command/$prefixStyle/prefix=$prefixLength', ({ text, id }) => {
  expect(routeLocalCommand(text).commands).toEqual([expect.objectContaining({ id })]);
});

it.each(matrixPrefixes.flatMap((lead) => ['open', 'opne'].flatMap((action) =>
  matrixQuotes.map(({ style, open, close }) => ({
    action, style, prefixStyle: lead.includes('İ') ? 'expanding-case' : 'ordinary', prefixLength: lead.length, text: lead + action + ' ' + open + 'settings' + close,
  })),
)))('quote matrix retains outside $action with $style object/$prefixStyle/prefix=$prefixLength', ({ text }) => {
  expect(routeLocalCommand(text).commands).toEqual([
    expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
  ]);
});


describe('unchanged independent Unicode source-offset probe', () => {
const prefix = 'İ want you to '.repeat(20);

it('review: supports the normalized Unicode polite wrapper before a bare command', () => {
  const text = prefix + 'open settings';
  expect(routeLocalCommand(text).commands).toEqual([
    expect.objectContaining({ id: 'page.open', slots: { route: 'settings' } }),
  ]);
  expect(requiresLocalCommandPreflight(text)).toBe(true);
});

it.each(['"open settings";', '“opne settings”.', '`next song`!'])(
  'preserves the outside command original offset after expanding-case wrappers and %s', (quoted) => {
    const text = 'İ want you to '.repeat(20) + quoted + ' open settings';
    expect(routeLocalCommand(text).commands).toEqual([
      expect.objectContaining({
        id: 'page.open', source: 'open settings', sourceStart: text.lastIndexOf('open settings'),
        sourceEnd: text.length,
      }),
    ]);
  },
);

it('preserves the entire original source for a supported Unicode wrapper and quoted object', () => {
  const text = 'İ want you to '.repeat(20) + 'open "settings"';
  expect(routeLocalCommand(text).commands).toEqual([
    expect.objectContaining({ id: 'page.open', source: text, sourceStart: 0, sourceEnd: text.length }),
  ]);
});

it('review: does not move a quoted command outside its original range after Unicode lowercase expansion', () => {
  const text = prefix + '"open settings";';
  expect.soft(routeLocalCommand(text).commands).toEqual([]);
  expect(requiresLocalCommandPreflight(text)).toBe(false);
});

});
