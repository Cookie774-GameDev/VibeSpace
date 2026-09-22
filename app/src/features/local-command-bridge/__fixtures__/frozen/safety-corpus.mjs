const NOISE = Object.freeze([
  "I am writing a long technical explanation about desktop assistant routing. This paragraph is ordinary prose and does not ask the application to perform any control action. A safe router should preserve explanatory context for the selected model and should not infer side effects merely because product names, interface nouns, command IDs, or action verbs appear in a discussion.",
  "The benchmark is intentionally adversarial. It talks about terminals, files, settings, panels, status indicators, backgrounds, buttons, fonts, music, Claude, Codex, OpenCode, and navigation. Those words are evidence only when they participate in a direct imperative speech act aimed at the application. A noun appearing in an article, example, screenshot, file name, historical report, hypothetical, or quoted sentence is not enough.",
  "False positives are more dangerous than ordinary unmatched wording because an incorrect command can change user state. The local router should therefore fail closed when it sees an explanation of how a command works, a request to write about a command, a quoted command from somebody else, a capability question, a future plan, or a negative instruction. This text deliberately repeats command vocabulary while remaining non-executable.",
  "A model-facing request can ask for analysis, documentation, examples, code, UI copy, or a report that mentions command phrases. That should not cause the desktop app to perform those phrases. For instance a user may want a tutorial that contains the literal words open settings, or a screenshot caption that says show router status, or test data containing change background to green. Those are content tasks, not side effects.",
  "Long user messages also contain past-tense narration and third-person reports. Saying that a teammate opened Codex yesterday or that I renamed a button last week is historical context. Saying that another user asked to open files is reported speech. Saying that I might open a terminal later is a future possibility. None of these should execute now.",
  "Questions are another important boundary. Asking how to open a terminal, why somebody would show status, whether the app can open settings, or whether changing a background would help is not the same as directly asking the application to do it. The parser should distinguish a question about an action from a polite direct request for the action.",
]);

const NEGATIVE_TEMPLATES = Object.freeze([
  'The documentation says "open a Claude terminal" as an example.',
  'The tutorial contains the sentence "open a Codex terminal" but I am only quoting it.',
  'The phrase "show router status" appears in the README.',
  'The words "change the background to green" are test data.',
  'A screenshot caption says "rename the button to Launch".',
  'Yesterday I opened a Claude terminal and later used Codex.',
  'Two hours ago I changed the background to purple.',
  'Last week I renamed the button to Start.',
  'My teammate opened the files page earlier.',
  'Another user said "open settings" in a chat log.',
  'If someone says "open a terminal", the parser should inspect context.',
  'When a user asks "show status", the app may expose diagnostics.',
  'Imagine I asked you to open the side panel.',
  'Suppose somebody told the assistant to play music.',
  'I might open a terminal later after this work is finished.',
  'I plan to open settings tomorrow.',
  'I will probably use Claude Code later.',
  'Should I open a terminal before debugging?',
  'Would opening a Codex terminal help with this problem?',
  'Why would somebody change the background to red?',
  'How do I open the files page?',
  'Can this application open a terminal at all?',
  'Does the router know how to show status?',
  'Is it possible to rename the button dynamically?',
  'Tell me how to open a Claude terminal without actually doing it.',
  'Show me how to open a Codex terminal, but do not open one.',
  'Explain how to change the background to green.',
  'Write a tutorial containing the command "open settings".',
  'Create a list of examples that includes "show router status".',
  'Generate documentation for "rename the button to Ship Game".',
  'Open the documentation about Claude terminals, not a terminal.',
  'Open the article about Codex consoles.',
  'Open a file containing the words "open a terminal".',
  'Open the file named settings-notes.txt.',
  'Open a report about router status.',
  'Show me a screenshot of router status.',
  'Show me an image explaining the side panel.',
  'Show me a list of terminal commands.',
  'Show me an explanation of how to open files.',
  'Play the video about music controls.',
  'Play the tutorial that explains how music playback works.',
  'Change the sentence "background to green" in this report.',
  'Change the example background color mentioned in the documentation.',
  'Rename the phrase "button" to "control" in this paragraph.',
  'Rename the example button in the screenshot caption, not the actual app button.',
  'Make the text in this document bigger in the generated HTML, not the app UI.',
  'Increase the font size described in the report, not the live application.',
  'Do not open a terminal.',
  'Please do not open a Codex terminal.',
  "Please don't open a Claude terminal.",
  'Never open settings because this is only a test.',
  'Do not show router status.',
  'Do not change the background to purple.',
  'Do not rename the button.',
  'Do not open the side panel.',
  'Do not play music.',
  'Do not pause music.',
  'I do not want you to open a terminal.',
  "I don't want you to open settings.",
  'There is no need to show router status.',
  'Without opening a terminal, explain the workflow.',
  'Avoid opening Codex while writing the report.',
  'Refrain from changing the background.',
  'Under no circumstances open a Claude terminal.',
  'Leave the side panel closed.',
  'Keep the music paused; do not resume it.',
  'The string terminal.open is a command ID, not a request.',
  'The identifier page.open is mentioned in source code.',
  'The value status.show appears in a JSON fixture.',
  'The text button.rename is part of a test case.',
  'The command appearance.background.set is being documented.',
  'The word Claude appears in a provider comparison.',
  'The word Codex appears in a benchmark result.',
  'The phrase OpenCode terminal is a heading in this report.',
  'Please write the words "open files" into the output.',
  'Please quote "show router status" exactly in the answer.',
  'Please include "change background to blue" in a code sample.',
  'Please put "open settings" on a demo button label.',
  'Please describe why a user might rename a button.',
  'Please compare opening Claude versus opening Codex without opening either.',
  'Please summarize the documentation section called "Open Terminal".',
  'Please analyze the sentence "go to tools" grammatically.',
  'Please translate "open files" into Spanish.',
  'Please count how many times the phrase "show status" appears.',
  'Please find the words "change background" in this paragraph.',
  'Please explain whether "open a terminal" is imperative grammar.',
  'Please create unit tests for the string "open settings".',
  'Please write HTML text that says "Show router status".',
  'Please generate a fake chat where someone says "open a Claude terminal".',
  'Please simulate a user saying "open files" in a written example only.',
  'Please create a markdown table with a row named "rename button".',
  'Please discuss the pros and cons of opening multiple terminals.',
  'Please tell me what would happen if I opened settings.',
  'Please reason about whether showing status leaks information.',
  'Please explain how a background color command should be authorized.',
  'Please explain how a button rename command should be parsed.',
  'Please inspect a screenshot where the text says "open tools".',
]);

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

function shuffle(rng, array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = int(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function generateNegativeCase(seed, index = 1, targetWords = 2500) {
  const rng = xorshift32(seed);
  const blocks = [];
  const decoys = shuffle(rng, NEGATIVE_TEMPLATES);

  for (let i = 0; i < 18 + int(rng, 14); i += 1) {
    blocks.push(decoys[i % decoys.length]);
    if (i % 3 === 0) blocks.push(pick(rng, NOISE));
  }

  while (blocks.join(' ').split(/\s+/u).filter(Boolean).length < targetWords) {
    blocks.push(pick(rng, NOISE));
    blocks.push(pick(rng, decoys));
  }

  blocks.push(
    'Finish by analyzing the routing safety problem in prose only. Do not perform any application command from this benchmark prompt.'
  );

  const text = blocks.join('\n\n');
  return {
    name: 'negative_' + String(index).padStart(3, '0'),
    seed: seed >>> 0,
    text,
    words: text.split(/\s+/u).filter(Boolean).length,
    expected: [],
    route: 'llm_only',
  };
}

export function generateNegativeCorpus(seedBase, count = 100, targetWords = 2500) {
  return Array.from({ length: count }, (_, i) => {
    const seed = (seedBase + Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    return generateNegativeCase(seed, i + 1, targetWords);
  });
}
