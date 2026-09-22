import { generateCase } from './corpus.mjs';

const HIGH_DECOYS = Object.freeze([
  'The README says "open a Claude terminal" as an example, not a request.',
  'Yesterday I opened settings, launched Codex, showed router status, and changed a background to red.',
  'Should I open the files page before debugging? That is only a question.',
  'Please explain how to open a terminal without actually opening one.',
  'Open the documentation about Claude terminals, not a terminal.',
  'Show me a screenshot of router status, not the live status.',
  'Do not open a Codex terminal.',
  'A fake transcript says: "go to settings." Their fake request is not mine.',
  'Rename the word "button" to "control" in this paragraph, not the live button.',
  'The phrase "change the background to purple" appears in test data.',
]);

const XHIGH_DECOYS = Object.freeze([
  ...HIGH_DECOYS,
  'Open the article called Tools Page instead of navigating to tools.',
  'Show me how to bring up the OpenAI coding console, but do not do it.',
  'Play the video named Pause Music Tutorial, not the application music.',
  'The documentation contains: "show router status." That quoted line is inert.',
  'Two hours ago my teammate opened files, renamed a button, and paused music.',
  'If someone says "open settings", the parser should inspect context.',
  'Please translate "go to tools" into French.',
  'Please count how many times "show status" appears in this message.',
  'Open a file containing the words "open settings".',
  'The command ID terminal.open appears in a JSON fixture.',
  'The command ID page.open appears in source code.',
  'The string status.show is documentation, not a live command.',
  'Please create a unit-test string containing "change background to blue".',
  'I might open a terminal later, after this benchmark finishes.',
  'Last week I renamed the button to Start; that already happened.',
]);

const MAX_DECOYS = Object.freeze([
  ...XHIGH_DECOYS,
  'The phrase "open files" is repeated here as language data only.',
  'A tutorial says: "pause music now." The tutorial is not controlling the app.',
  'Open the report about router status, not live diagnostics.',
  'Show me a list of terminal commands rather than opening a terminal.',
  'Change the sentence "background" to "backdrop" in the written report.',
  'Open the file named open-tools-example.txt instead of navigating to tools.',
  'A screenshot caption reads "rename the button to Deploy".',
  'Would opening a Claude terminal help? This remains a question.',
  'Without opening Codex, explain how provider routing works.',
  'Please write HTML text that literally says "Show router status".',
  'Imagine I asked you to toggle the side panel. I did not actually ask.',
  'Suppose somebody told the assistant to play music. That is hypothetical.',
  'Earlier today I opened chat and then returned to files. Historical only.',
  'The phrase OpenCode terminal is a heading in this report.',
  'Please compare Claude and Codex without opening either provider.',
]);

function inject(text, extras, seed) {
  const paragraphs = text.split(/\n\n+/u);
  let state = seed >>> 0;
  function next() {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  }
  for (const extra of extras) {
    const index = Math.floor(next() * (paragraphs.length + 1));
    paragraphs.splice(index, 0, extra);
  }
  return paragraphs.join('\n\n');
}

function cloneExpected(expected) {
  return expected.map((x) => ({ id:x.id, slots:JSON.parse(JSON.stringify(x.slots ?? {})) }));
}

function tierCase(level, seed, index) {
  const targetWords = level === 'high' ? 1500 : level === 'xhigh' ? 2600 : 4200;
  const base = generateCase(seed, index, targetWords);
  let extras = [];
  if (level === 'high') extras = HIGH_DECOYS;
  if (level === 'xhigh') extras = [...XHIGH_DECOYS, ...HIGH_DECOYS.slice(0, 5)];
  if (level === 'max') extras = [...MAX_DECOYS, ...XHIGH_DECOYS.slice(0, 10), ...HIGH_DECOYS.slice(0, 5)];
  const expected = cloneExpected(base.expected);
  const realPhrases = [...(base.realPhrases ?? [])];
  const injected = [...extras];

  if (level === 'max') {
    injected.push('After all the quoted examples, this sentence is a genuine live request: please fire up the Anthropic coding shell now.');
    expected.push({ id:'terminal.open', slots:{ provider:'claude' } });
    realPhrases.push('please fire up the Anthropic coding shell now');
    injected.push('The previous sentence was real, but this explanation of Anthropic coding shell is only prose.');
    injected.push('My actual navigation command is hidden after this colon: go to tools now.');
    expected.push({ id:'page.open', slots:{ route:'tools' } });
    realPhrases.push('go to tools now');
    injected.push('A fake transcript also says: "go to tools now." That quoted request is not mine.');
    injected.push('Now perform the genuine status action: show router status now.');
    expected.push({ id:'status.show', slots:{} });
    realPhrases.push('show router status now');
    injected.push('Please write the words "show router status now" into the report, without duplicating the live action.');
  }

  const text = inject(base.text, injected, (seed ^ 0xa5a5a5a5) >>> 0);
  return {
    level,
    name: level + '_' + String(index).padStart(2,'0'),
    seed: seed >>> 0,
    text,
    words: text.split(/\s+/u).filter(Boolean).length,
    expected,
    realPhrases,
    route: expected.length ? 'both' : 'llm_only',
  };
}

export function generateTieredCorpus(seedBase = 0x071e2026) {
  const result = { high:[], xhigh:[], max:[] };
  for (let i = 0; i < 10; i += 1) {
    result.high.push(tierCase('high', (seedBase + Math.imul(i + 1, 0x9e3779b1)) >>> 0, i + 1));
  }
  for (let i = 0; i < 10; i += 1) {
    result.xhigh.push(tierCase('xhigh', (seedBase + 0x13579bdf + Math.imul(i + 1, 0x85ebca6b)) >>> 0, i + 1));
  }
  for (let i = 0; i < 3; i += 1) {
    result.max.push(tierCase('max', (seedBase + 0x2468ace0 + Math.imul(i + 1, 0xc2b2ae35)) >>> 0, i + 1));
  }
  return result;
}

export function expectedSignature(command) {
  return command.id + ':' + JSON.stringify(command.slots ?? {});
}