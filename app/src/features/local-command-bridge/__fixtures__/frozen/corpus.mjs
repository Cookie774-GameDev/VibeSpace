const BASE_PARAGRAPHS = Object.freeze([
  "I am building a study-oriented HTML application that should stay useful on a phone and on a desktop. The content comes from a source document, so factual wording matters more than decoration. The user should see one clear question at a time, four possible answers, immediate feedback, a score, progress, and a restart control. The interface should not need multiple pages just to answer a question. Keyboard focus, touch target size, readable contrast, and predictable navigation all matter because the same project may be used by people with very different devices. This paragraph is ordinary model work and is not an instruction to manipulate the test harness.",
  "A long chat message can contain both creative work and tiny application controls. The routing layer must preserve the creative request exactly while pulling out only actual imperative controls. It is especially important not to react merely because a paragraph contains words like terminal, background, button, status, Claude, Codex, panel, music, settings, or files. Those nouns appear naturally while people explain what they are building. The router should care about speech act and local context, not just keywords. Discussion about a command is not the same thing as issuing that command, and this benchmark intentionally repeats those terms many times.",
  "The command system also needs to be conservative around quotations and examples. Documentation might contain a sentence such as open a terminal, and a tutorial might demonstrate change the background to green, but those strings should remain inert when they are being cited. Historical narration is similar. Saying that yesterday I opened Claude or that a teammate previously used Codex reports past behavior rather than asking the application to do something now. The same principle applies to hypothetical language, conditions, benchmarks, examples, and explanatory prose about how an action would work.",
  "Human typing is noisy. People transpose letters, omit vowels, add an extra character, use shorthand, and refer to branded tools indirectly. A person might call Claude the Anthropic coding shell or describe Codex as the OpenAI coding console. A deterministic local system can still understand stable product vocabulary without using a language model if it normalizes a small trusted lexicon and keeps ambiguity bounded. The key is to avoid turning broad fuzzy matching into permission to execute. Exact and high-confidence evidence should win, while uncertain cases should remain unresolved.",
  "For this benchmark the surrounding task is substantive model work. Imagine that the user wants a complete HTML game, wants an attached document interpreted faithfully, wants explanations of design choices, wants mobile behavior checked, and wants the final code rather than a plan. The placeholder model does not actually need to generate the artifact. The benchmark only needs to verify that command spans are removed and that the rest of this long request remains available. This gives us a strict way to evaluate the router independently from whichever model or local model eventually handles the creative work.",
  "Authorization and interpretation must remain separate. Even if a router identifies a command perfectly, it should not decide whether a destructive operation is allowed. That belongs to the host application's command catalog, safety level, confirmation flow, capability checks, receipts, and executor. The local router built here returns only intent, slots, confidence, and exact source offsets. Keeping those responsibilities separate makes the language layer easier to test and means the same router can later sit in front of a much larger catalog without inheriting authority it should never have.",
  "Speed matters as much as accuracy because obvious controls should feel instant. The best path should be a constant-time alias lookup for short exact commands. Longer mixed messages can afford bounded local analysis, but that analysis should still avoid comparing every token against every command. A small typo index, family gating, and stable entity maps are enough for the kinds of commands being tested here. The benchmark records median, tail latency, false positives, false negatives, and exact command signatures rather than treating a single successful example as proof.",
  "Long messages are deliberately repetitive because real users often restate requirements, revise wording, and include context that resembles instructions. A robust parser should not create duplicate side effects from repeated explanatory sentences. It should also survive phrases like the words show status are used by the documentation, or a benchmark ought to test rename button, or if someone says open settings then a parser may choose a route. Those are meta-level statements. A real imperative should have stronger evidence such as a direct action, a polite request wrapper, or a clear correction of an earlier instruction.",
  "The residual text matters because it is what the selected language model receives. Removing too much changes the user's request, while removing too little can distract the model with application controls. Exact original offsets are preferable to rewriting because they preserve spelling, punctuation, attachments, and personal phrasing. Connector cleanup should be mechanical and minimal. If an extracted command followed and also or and then, the leftover connector should not dangle at the end of the previous sentence. Nothing else should be paraphrased.",
  "The final quality target is intentionally strict. An evaluation counts as correct only if the command IDs and slots match exactly and the overall route is correct. An extra false-positive command fails the whole prompt. Missing one buried command also fails. This is harder than measuring per-token precision but better reflects the risk of a desktop assistant. The test generator therefore includes prompts with zero real commands, prompts with several commands, provider conflicts, explicit negations, corrections, spelling noise, and commands inserted at unpredictable positions among thousands of ordinary words."
]);

const COMMAND_TEMPLATES = Object.freeze([
  {
    id: 'terminal.open',
    slot: { provider: 'shell' },
    variants: [
      'open a terminal',
      'please open a terminal',
      'launch a new terminal',
      'start a terminal for me',
      'could you bring up a terminal for me',
    ],
  },
  {
    id: 'terminal.open',
    slot: { provider: 'claude' },
    variants: [
      'open a Claude terminal',
      'please launch Claude Code in a terminal',
      'could you fire up that Anthropic coding shell for me',
      'spin up the Anthropic coding console',
      'hey pls opean a termnal with cloude in it',
    ],
  },
  {
    id: 'terminal.open',
    slot: { provider: 'codex' },
    variants: [
      'open a Codex terminal',
      'please launch Codex in a terminal',
      'could you bring up the OpenAI coding console for me',
      'spin up the OpenAI coding shell',
      'start an OpenAI Codex terminal',
    ],
  },
  {
    id: 'terminal.open',
    slot: { provider: 'opencode' },
    variants: [
      'open an OpenCode terminal',
      'please launch OpenCode CLI in a terminal',
      'start an open code terminal',
    ],
  },
  {
    id: 'appearance.background.set',
    slot: { color: 'green' },
    variants: [
      'change the background to green',
      'please make the background green',
      'set the background to green',
    ],
  },
  {
    id: 'appearance.background.set',
    slot: { color: 'purple' },
    variants: [
      'change the background to purple',
      'please make the background purple',
      'chnage the backgroun to purpel',
    ],
  },
  {
    id: 'appearance.background.set',
    slot: { color: 'blue' },
    variants: [
      'change the background to blue',
      'make the backdrop blue',
      'set the page color to blue',
    ],
  },
  {
    id: 'appearance.background.set',
    slot: { color: 'red' },
    variants: [
      'change the background to red',
      'make the background crimson',
      'set the backdrop to red',
    ],
  },
  {
    id: 'panel.open',
    slot: {},
    variants: ['open the side panel', 'please open the sidebar', 'pull up the side panel'],
  },
  {
    id: 'panel.close',
    slot: {},
    variants: ['close the side panel', 'please close the sidebar', 'hide the side panel'],
  },
  {
    id: 'panel.toggle',
    slot: {},
    variants: ['toggle the side panel', 'flip the sidebar', 'toggle the panel'],
  },
  {
    id: 'status.show',
    slot: {},
    variants: ['show router status', 'please display status', 'show the diagnostic status'],
  },
  {
    id: 'font.adjust',
    slot: { direction: 'increase' },
    variants: ['increase the font size', 'make the text bigger', 'please enlarge the text'],
  },
  {
    id: 'font.adjust',
    slot: { direction: 'decrease' },
    variants: ['decrease the font size', 'make the text smaller', 'please shrink the text'],
  },
  {
    id: 'music.play',
    slot: {},
    variants: ['play music', 'please start the music', 'start music'],
  },
  {
    id: 'music.pause',
    slot: {},
    variants: ['pause music', 'please pause the music', 'halt the music'],
  },
  {
    id: 'music.resume',
    slot: {},
    variants: ['resume music', 'please resume the music', 'resume the music'],
  },
  {
    id: 'music.stop',
    slot: {},
    variants: ['stop music', 'please stop the music', 'stop the music'],
  },
  {
    id: 'page.open',
    slot: { route: 'settings' },
    variants: ['open settings', 'please open the settings page', 'go to settings'],
  },
  {
    id: 'page.open',
    slot: { route: 'chat' },
    variants: ['open chat', 'please open the chat page', 'go to chat'],
  },
  {
    id: 'page.open',
    slot: { route: 'tools' },
    variants: ['open tools', 'please open the tools page', 'go to tools'],
  },
  {
    id: 'page.open',
    slot: { route: 'files' },
    variants: ['open files', 'please open the file browser', 'go to files'],
  },
  {
    id: 'page.open',
    slot: { route: 'schedule' },
    variants: ['open the schedule', 'please open the calendar', 'go to schedule'],
  },
]);

const LABELS = Object.freeze([
  'Ship Game',
  'Launch Study',
  'Continue Quiz',
  'Final Boss',
  'Start Round',
  'Check Answer',
]);

function buttonTemplate(label) {
  return {
    id: 'button.rename',
    slot: { label },
    variants: [
      'rename the button to ' + label,
      'change the button text to ' + label,
      'set the button label to ' + label,
    ],
  };
}

function xorshift32(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function int(rng, max) {
  return Math.floor(rng() * max);
}

function pick(rng, array) {
  return array[int(rng, array.length)];
}

function shuffled(rng, array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = int(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function signature(command) {
  return command.id + ':' + JSON.stringify(command.slot ?? {});
}

function decoyFor(rng, phrase) {
  const decoys = [
    'The documentation uses the phrase "' + phrase + '" as an example, not as an instruction.',
    'If someone says "' + phrase + '", the parser still needs to inspect the surrounding speech act.',
    'A benchmark ought to test the words "' + phrase + '" without executing them.',
    'Yesterday I read a tutorial that said "' + phrase + '", but that describes the tutorial rather than a current request.',
    'We previously discussed "' + phrase + '" as historical context only.',
    'The phrase "' + phrase + '" appears in test data and should remain inert.',
  ];
  return pick(rng, decoys);
}

function negatedFor(phrase) {
  const cleaned = phrase.replace(/^(?:please\s+|could\s+you\s+|hey\s+pls\s+)/i, '');
  return 'Do not ' + cleaned.replace(/[.!?]+$/g, '') + '; I am explicitly cancelling that control.';
}

function substantiveTail(caseNo) {
  return 'Please continue the actual document-grounded HTML game work for evaluation case ' + caseNo
    + ', keep the accessibility and mobile requirements, and return the complete useful result rather than only a plan.';
}

function makeCommand(rng) {
  if (rng() < 0.16) {
    const label = pick(rng, LABELS);
    const template = buttonTemplate(label);
    return { ...template, phrase: pick(rng, template.variants) };
  }
  const template = pick(rng, COMMAND_TEMPLATES);
  return { ...template, slot: clone(template.slot), phrase: pick(rng, template.variants) };
}

function insertAt(array, index, item) {
  array.splice(Math.max(0, Math.min(index, array.length)), 0, item);
}

export function generateCase(seed, caseNo = 1, targetWords = 4000) {
  const rng = xorshift32(seed);
  const blocks = [];
  while (blocks.join(' ').split(/\s+/u).length < targetWords - 700) {
    for (const paragraph of shuffled(rng, BASE_PARAGRAPHS)) {
      blocks.push(paragraph + ' This is randomized holdout case ' + caseNo + ' and the surrounding prose remains ordinary model context.');
      if (blocks.join(' ').split(/\s+/u).length >= targetWords - 700) break;
    }
  }

  const expected = [];
  const realCount = int(rng, 7);
  const realCommands = [];
  for (let i = 0; i < realCount; i += 1) {
    const command = makeCommand(rng);
    realCommands.push(command);
    expected.push({ id: command.id, slots: clone(command.slot) });
  }

  // Insert many inert decoys, including exact command-looking text.
  const decoyCount = 12 + int(rng, 10);
  for (let i = 0; i < decoyCount; i += 1) {
    const source = makeCommand(rng);
    insertAt(blocks, int(rng, blocks.length + 1), decoyFor(rng, source.phrase));
  }

  // Add 2-5 explicit negations that must never execute.
  const negatedCount = 2 + int(rng, 4);
  for (let i = 0; i < negatedCount; i += 1) {
    const source = makeCommand(rng);
    insertAt(blocks, int(rng, blocks.length + 1), negatedFor(source.phrase));
  }

  // Mix real commands into different discourse positions.
  for (let i = 0; i < realCommands.length; i += 1) {
    const command = realCommands[i];
    let phrase = command.phrase;
    const style = int(rng, 5);
    if (style === 1) phrase = 'And also ' + phrase;
    else if (style === 2) phrase = 'At the very end, ' + phrase;
    else if (style === 3) phrase = 'While you work, ' + phrase;
    else if (style === 4) phrase = 'Actually, ' + phrase;
    insertAt(blocks, int(rng, blocks.length + 1), phrase.replace(/[.!?]*$/u, '') + '.');
  }

  // Sometimes include a cancelled-provider correction. The negated clause must be inert.
  if (rng() < 0.45) {
    const useClaude = rng() < 0.5;
    const corrected = useClaude
      ? { id: 'terminal.open', slots: { provider: 'claude' } }
      : { id: 'terminal.open', slots: { provider: 'codex' } };
    const correction = useClaude
      ? 'Do not open a Codex terminal; actually open a Claude terminal instead.'
      : 'Do not open a Claude terminal; actually open a Codex terminal instead.';
    insertAt(blocks, int(rng, blocks.length + 1), correction);
    expected.push(corrected);
  }

  blocks.push(substantiveTail(caseNo));

  // Pad after all insertions so every case clears the target even when the base bank changes.
  while (blocks.join(' ').split(/\s+/u).length < targetWords) {
    blocks.push(pick(rng, BASE_PARAGRAPHS) + ' This padding paragraph is still substantive model context and contains no live control request.');
  }

  const text = blocks.join('\n\n');
  return {
    name: 'case_' + String(caseNo).padStart(2, '0'),
    seed,
    text,
    words: text.split(/\s+/u).filter(Boolean).length,
    expected,
    realPhrases: realCommands.map((command) => command.phrase),
    expectedSignatures: expected.map((command) => signature({ id: command.id, slot: command.slots })).sort(),
    route: expected.length ? 'both' : 'llm_only',
  };
}

export function generateCorpus(seedBase, count = 10, targetWords = 4000) {
  const cases = [];
  for (let i = 0; i < count; i += 1) {
    const seed = (seedBase + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    cases.push(generateCase(seed, i + 1, targetWords));
  }
  return cases;
}

export function expectedSignature(command) {
  return command.id + ':' + JSON.stringify(command.slots ?? {});
}
