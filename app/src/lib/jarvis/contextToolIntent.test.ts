import { describe, expect, it } from 'vitest';
import {
  parseDirectContextEvidenceContinuation,
  parseMandatoryContextEvidenceResearch,
  requestsDirectContextAddress,
  requestsReadOnlyContextTool,
} from './contextToolIntent';

const LIVE_TEST07_MANDATORY_RESEARCH = `Use only the production vibespace_context tool against the currently approved physical Test07 Context Map. Current physical bytes are the only authority. Complete both stages below in this single provider turn before writing any answer.

STAGE 1 — REQUIRED SEARCHES
Make exactly five search calls, one for each numbered question below, each with limit 3. Do not answer after the searches.

STAGE 2 — REQUIRED PHYSICAL EVIDENCE
From those five search results, select the canonical trusted pointer for each of these exact six required sources: shard-0000.txt, shard-0025.txt, shard-0047.txt, shard-0048.txt, shard-0063.txt, shard-0095.txt. Then make exactly six expand calls, one per selected source, with beforeBytes=256 and afterBytes=0. These six expand calls are mandatory even when a search preview appears to contain an answer. Search previews are not sufficient evidence. Do not call open, address, or any other tool. Reject STATUS SUPERSEDED_UNTRUSTED. Total expanded physical text must be <=24 KiB.

QUESTIONS
1. In the fresh Test07 archive, what verification key is assigned to the canonical Frostglass Array checkpoint at the end-boundary record?
2. For the canonical Moonwake Beacon opening-boundary record, what recovery color and verification number are active?
3. The canonical Northwind relay handoff crosses two neighboring Test07 shards. What phrase was left by the sending clerk, and what answer did the receiving clerk pair with it?
4. According to the canonical middle-region record for Station Emberline, where is the emergency sextant stored and what is its verification number?
5. At the final-boundary canonical record for Observatory Kestrel, who signed the calibration and what non-guessable multiplier was recorded?

OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS
Return a compact Q1–Q5 table. For each answer include the exact answer, exact filename, canonical RECORD_ID, RECORD_REVISION, canonical record 1-based line range, canonical record half-open byte range, and full sourceVersion/contentHash as exactly 64 lowercase hexadecimal characters with no prefix or link. Include rejected decoy values. Q3 must include both sources independently. End with exact search count, expand count, and aggregate expanded bytes. If you cannot make exactly five searches followed by exactly six expansions or cannot verify any physical fact, output FAIL instead of a partial answer.`;

const LIVE_TEST07_PRIOR_POINTER_CONTINUATION = `Your prior answer is incomplete because it used previews only and omitted required physical provenance. Do not repeat any search and do not reuse preview text as evidence.

Using only the exact six search-result pointers already returned in this chat for shard-0000.txt, shard-0025.txt, shard-0047.txt, shard-0048.txt, shard-0063.txt, and shard-0095.txt, make exactly six vibespace_context expand calls: one per source, each with beforeBytes=256 and afterBytes=0. Do not call open, search, address, or any other tool. Reject STATUS SUPERSEDED_UNTRUSTED.

Then return the compact Q1–Q5 table with the verified exact answer, exact filename, canonical RECORD_ID, RECORD_REVISION, canonical record 1-based line range, canonical record half-open byte range, full sourceVersion/contentHash as exactly 64 lowercase hex characters with no prefix or link, and rejected decoy value. Q3 must include both sources independently. End with exactly: prior searches=5; this-turn expands=6; total retrieval calls=6; aggregate expanded bytes=<exact sum>. If the exact prior pointers are unavailable or any required physical fact cannot be read from the six results, say FAIL rather than guessing.`;

const LIVE_TEST08_ADDRESS_BATCH_1 = `This is batch 1 of 2 for one Test08 run in the same retained chat.
Use the production vibespace_context address operation only. Do not use search, open, or expand.
Make exactly 9 address calls, one for each case below, and no other tool calls.
For each call, use the exact corpusId and canonical decimal position.
Return one row per case in this order: corpusId | position | shard | offset | tokenStart | tokenEnd | source filename | source SHA-256 | exact CANONICAL_MARKER.
Do not infer missing values. Sparse logical addressability is under test.
Truth labels: 10B PHYSICAL INGESTION: NOT RUN; TRANSPORT CANCELLATION: NOT CERTIFIED.
- t08-boundary-100b @ 99999999999
- t08-boundary-100b @ 100000000000
- t08-boundary-100b @ 100000000001
- t08-boundary-10b @ 9999999999
- t08-boundary-10b @ 10000000000
- t08-boundary-10b @ 10000000001
- t08-boundary-10b @ 10000000002
- t08-boundary-1b @ 999999999
- t08-boundary-1b @ 1000000000`;

const LIVE_TEST08_ADDRESS_BATCH_2 = `This is batch 2 of 2 for one Test08 run in the same retained chat.
Use the production vibespace_context address operation only. Do not use search, open, or expand.
Make exactly 8 address calls, one for each case below, and no other tool calls.
For each call, use the exact corpusId and canonical decimal position.
Return one row per case in this order: corpusId | position | shard | offset | tokenStart | tokenEnd | source filename | source SHA-256 | exact CANONICAL_MARKER.
Do not infer missing values. Sparse logical addressability is under test.
Truth labels: 10B PHYSICAL INGESTION: NOT RUN; TRANSPORT CANCELLATION: NOT CERTIFIED.
- t08-boundary-1b @ 1000000001
- t08-safe-transition @ 9007199254740991
- t08-safe-transition @ 9007199254740992
- t08-safe-transition @ 9007199254740993
- t08-size-exact-10b @ 5000000000
- t08-size-exact-10b-plus-1 @ 10000000000
- t08-size-exact-1b @ 500000000
- t08-supported-maximum @ 9999999999999999`;

describe('requestsDirectContextAddress', () => {
  const exactJson = '{"operation":"address","corpusId":"uat-a","position":"10000000000"}';

  it.each([LIVE_TEST08_ADDRESS_BATCH_1, LIVE_TEST08_ADDRESS_BATCH_2])(
    'admits an exact live batch that forbids only substitute operations',
    (prompt) => {
      expect(requestsDirectContextAddress(prompt)).toBe(true);
    },
  );

  it('rejects a live-form address call count that does not match its tuples', () => {
    expect(
      requestsDirectContextAddress(
        LIVE_TEST08_ADDRESS_BATCH_1.replace(
          'Make exactly 9 address calls',
          'Make exactly 8 address calls',
        ),
      ),
    ).toBe(false);
  });

  it.each([
    `Call vibespace_context with ${exactJson}.`,
    `Please invoke vibespace_context with ${exactJson} exactly once.`,
    [
      'Use vibespace_context address operation only. Make these three calls in order:',
      '- uat-a @ 0',
      '- uat-a @ 9007199254740992',
      '- uat-b_2@revision.7 @ 10000000000000000',
    ].join('\n'),
  ])('accepts complete exact address tuples: %s', (prompt) => {
    expect(requestsDirectContextAddress(prompt)).toBe(true);
  });

  it.each([
    'Search the Context Map for address records.',
    'Explain whether vibespace_context.address is supported.',
    'Please explain how to call vibespace_context.address safely.',
    'Do not call vibespace_context.address.',
    `Do not make vibespace_context ${exactJson} calls.`,
    `Avoid calling vibespace_context with ${exactJson}.`,
    `Without calling vibespace_context, inspect ${exactJson}.`,
    `For vibespace_context ${exactJson}, do not make address calls.`,
    `Never invoke the address operation through vibespace_context with ${exactJson}.`,
    `No vibespace_context address calls: ${exactJson}.`,
    'Call vibespace_context.search or vibespace_context.address.',
    'Call vibespace_context with operation="address" or operation="search".',
    'Call vibespace_context with {"operation":"address","position":"10"}.',
    'Call vibespace_context with {"operation":"address","corpusId":"uat-a"}.',
    'Call vibespace_context with {"operation":"address","corpusId":"uat-a","position":"1e9"}.',
    'Call vibespace_context with {"operation":"address","corpusId":"uat-a","position":10000000000}.',
    'Call vibespace_context with {"operation":"address","corpusId":"../uat-a","position":"10"}.',
    'Call vibespace_context with {"operation":"address","corpusId":"uat:a","position":"10"}.',
    `Call vibespace_context with {"operation":"address","corpusId":"${'a'.repeat(201)}","position":"10"}.`,
    'Call vibespace_context with {"operation":"address","corpusId":"uat-a","position":"010"}.',
    'Call vibespace_context with {"operation":"address","corpusId":"uat-a","position":"10000000000000001"}.',
    `Call vibespace_context with ${exactJson} and ${exactJson}.`,
    `Call vibespace_context twice with ${exactJson}.`,
    [
      'Use vibespace_context address operation only. Make these two calls in order:',
      '- uat-a @ 10',
    ].join('\n'),
    [
      'Use vibespace_context address operation only. Make these two calls in order:',
      '- uat-a @ 10',
      '- uat-a @ 10',
    ].join('\n'),
    [
      'Use vibespace_context address operation only. Make these two calls in order:',
      '- uat-a @ 10',
      '- ../uat-b @ 11',
    ].join('\n'),
    [
      'Use vibespace_context address operation only. Make these one calls in order:',
      '- uat-a @ 10',
      '- uat-b @ 11',
    ].join('\n'),
    [
      'Use vibespace_context address operation only. Make these thirteen calls in order:',
      ...Array.from({ length: 13 }, (_, index) => `- uat-a @ ${index}`),
    ].join('\n'),
    'Call vibespace_context with operation="address\u0000".',
    `Call vibespace_context.address ${'x'.repeat(32_769)}`,
    'Call vibespace_context with operation="addresses".',
  ])('rejects a negative, ambiguous, descriptive, or malformed trigger: %s', (prompt) => {
    expect(requestsDirectContextAddress(prompt)).toBe(false);
  });

  it('accepts twelve unique exact JSON tuples but rejects a thirteenth', () => {
    const tuples = Array.from(
      { length: 13 },
      (_, index) => `{"operation":"address","corpusId":"uat-${index}","position":"${index}"}`,
    );

    expect(
      requestsDirectContextAddress(
        `Call vibespace_context with these twelve calls:\n${tuples.slice(0, 12).join('\n')}`,
      ),
    ).toBe(true);
    expect(
      requestsDirectContextAddress(
        `Call vibespace_context with these thirteen calls:\n${tuples.join('\n')}`,
      ),
    ).toBe(false);
  });

  it('uses the exact production corpus identifier grammar and length boundary', () => {
    const exact200CharacterId = `a@${'b'.repeat(198)}`;

    expect(
      requestsDirectContextAddress(
        `Call vibespace_context with {"operation":"address","corpusId":"uat@revision-1","position":"10"}.`,
      ),
    ).toBe(true);
    expect(
      requestsDirectContextAddress(
        `Call vibespace_context with {"operation":"address","corpusId":"${exact200CharacterId}","position":"10"}.`,
      ),
    ).toBe(true);
    expect(exact200CharacterId).toHaveLength(200);
  });
});

describe('bounded Test07 evidence intent', () => {
  it('recognizes the exact live mandatory five-search and six-source expansion contract', () => {
    expect(parseMandatoryContextEvidenceResearch(LIVE_TEST07_MANDATORY_RESEARCH)).toEqual({
      questionCount: 5,
      operation: 'expand',
      evidenceCount: 6,
      sources: [
        'shard-0000.txt',
        'shard-0025.txt',
        'shard-0047.txt',
        'shard-0048.txt',
        'shard-0063.txt',
        'shard-0095.txt',
      ],
      beforeBytes: 256,
      afterBytes: 0,
      maxTotalBytes: 24 * 1024,
      outputSuffix: LIVE_TEST07_MANDATORY_RESEARCH.slice(
        LIVE_TEST07_MANDATORY_RESEARCH.indexOf('OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS'),
      ),
    });
  });

  it.each([
    LIVE_TEST07_MANDATORY_RESEARCH.replace('OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS', ''),
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nOUTPUT ONLY AFTER ALL 11 REQUIRED CALLS`,
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS',
      `OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS\n${'x'.repeat(8_193)}`,
    ),
    `${LIVE_TEST07_MANDATORY_RESEARCH.slice(
      LIVE_TEST07_MANDATORY_RESEARCH.indexOf('OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS'),
    )}\n${LIVE_TEST07_MANDATORY_RESEARCH.slice(
      0,
      LIVE_TEST07_MANDATORY_RESEARCH.indexOf('OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS'),
    )}`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\u0000`,
  ])('rejects an unsafe mandatory output suffix boundary: %s', (prompt) => {
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'what non-guessable multiplier was recorded?\n\nOUTPUT ONLY AFTER ALL 11 REQUIRED CALLS',
      'what non-guessable OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS multiplier was recorded?',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'what non-guessable multiplier was recorded?\n\nOUTPUT ONLY AFTER ALL 11 REQUIRED CALLS',
      'what non-guessable multiplier was recorded? OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS',
    ),
  ])('rejects a mandatory output marker that is not a standalone post-question line', (prompt) => {
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nCall open with the selected pointer.`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nSearch again if a field is missing.`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nUse address to verify the byte range.`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nPerform another expand for certainty.`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nInvoke files.create with the completed table.`,
    `${LIVE_TEST07_MANDATORY_RESEARCH}\nEmit a tool invocation for schedule.create.`,
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- exact filename; then call open with the selected pointer.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return a compact Q1–Q5 table and call open with the selected pointer.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return a compact Q1–Q5 table. Please use address to verify it.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return a compact Q1–Q5 table, then call open with the selected pointer.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return a compact Q1–Q5 table; kindly invoke files.create afterward.',
    ),
  ])('rejects mandatory output text that attempts to invoke a tool or action: %s', (prompt) => {
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return files.create as the next operation.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- files.create',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return schedule.create as the next operation.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- schedule.create',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return vibespace_context.open as the next operation.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- vibespace_context.open',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return operation="open" before the table.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- operation="open"',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return {"operation":"open"} before the table.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- {"operation":"open"}',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return ```action files.create``` before the table.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- ```tool vibespace_context.open```',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Return a compact Q1–Q5 table.',
      'Return tool_call(files.create, {}) before the table.',
    ),
    LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      'Include rejected decoy values.\n- toolCall: vibespace_context.open({})',
    ),
  ])('rejects bare operation or tool-call authority syntax in mandatory output: %s', (prompt) => {
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    ['terminal.run', 'Return terminal.run before the table.'],
    ['terminal.run bullet', 'Include rejected decoy values.\n- terminal.run'],
    ['plugins.run', 'Return plugins.run before the table.'],
    ['plugins.run bullet', 'Include rejected decoy values.\n- plugins.run'],
    ['connectors.connect', 'Return connectors.connect before the table.'],
    ['connectors.connect bullet', 'Include rejected decoy values.\n- connectors.connect'],
    ['unknown create namespace', 'Return atlas.create before the table.'],
    ['unknown delete namespace bullet', 'Include rejected decoy values.\n- quasar.delete'],
    ['unknown execute namespace', 'Return northstar.execute before the table.'],
    ['unknown write namespace bullet', 'Include rejected decoy values.\n- horizon.write'],
  ])('rejects generalized dotted capability syntax: %s', (_label, replacement) => {
    const prompt = replacement.startsWith('Return')
      ? LIVE_TEST07_MANDATORY_RESEARCH.replace('Return a compact Q1–Q5 table.', replacement)
      : LIVE_TEST07_MANDATORY_RESEARCH.replace('Include rejected decoy values.', replacement);
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    ['files.read', 'Return files.read before the table.'],
    ['files.read bullet', 'Include rejected decoy values.\n- files.read'],
    ['schedule.list', 'Return schedule.list before the table.'],
    ['schedule.list bullet', 'Include rejected decoy values.\n- schedule.list'],
    ['settings.update', 'Return settings.update before the table.'],
    ['settings.update bullet', 'Include rejected decoy values.\n- settings.update'],
    ['get', 'Return account.get before the table.'],
    ['set', 'Return account.set before the table.'],
    ['copy', 'Return files.copy before the table.'],
    ['approve', 'Return approvals.approve before the table.'],
    ['deny', 'Return approvals.deny before the table.'],
    ['refresh', 'Return providers.refresh before the table.'],
    ['revoke', 'Return credentials.revoke before the table.'],
    ['download', 'Return files.download before the table.'],
    ['upload', 'Return files.upload before the table.'],
    ['multi-segment list', 'Return github.workflows.list before the table.'],
    ['multi-segment list bullet', 'Include rejected decoy values.\n- github.workflows.list'],
  ])('rejects registered or common dotted operation syntax: %s', (_label, replacement) => {
    const prompt = replacement.startsWith('Return')
      ? LIVE_TEST07_MANDATORY_RESEARCH.replace('Return a compact Q1–Q5 table.', replacement)
      : LIVE_TEST07_MANDATORY_RESEARCH.replace('Include rejected decoy values.', replacement);
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    ['browser.readPage', 'Return browser.readPage before the table.'],
    ['browser.readPage bullet', 'Include rejected decoy values.\n- browser.readPage'],
    ['browser.navigate', 'Return browser.navigate before the table.'],
    ['browser.navigate bullet', 'Include rejected decoy values.\n- browser.navigate'],
    ['browser.click', 'Return browser.click before the table.'],
    ['browser.click bullet', 'Include rejected decoy values.\n- browser.click'],
    ['browser.type', 'Return browser.type before the table.'],
    ['browser.type bullet', 'Include rejected decoy values.\n- browser.type'],
    ['browser.operator', 'Return browser.operator before the table.'],
    ['browser.operator bullet', 'Include rejected decoy values.\n- browser.operator'],
    ['future transform', 'Return aurora.transform before the table.'],
    ['future transform bullet', 'Include rejected decoy values.\n- aurora.transform'],
    ['future teleport', 'Return quantum.teleport before the table.'],
    ['future teleport bullet', 'Include rejected decoy values.\n- quantum.teleport'],
    ['disguised filename', 'Return browser.readPage.txt before the table.'],
    ['multi-segment future action', 'Include rejected decoy values.\n- browser.dom.click'],
  ])('default-denies capability-shaped dotted output syntax: %s', (_label, replacement) => {
    const prompt = replacement.startsWith('Return')
      ? LIVE_TEST07_MANDATORY_RESEARCH.replace('Return a compact Q1–Q5 table.', replacement)
      : LIVE_TEST07_MANDATORY_RESEARCH.replace('Include rejected decoy values.', replacement);
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });

  it.each([
    'Include rejected decoy values.\n- source filename shard-0000.txt',
    'Include rejected decoy values.\n- release version library.v1',
    'Include rejected decoy values.\n- benign dotted prose example.value',
    'Include rejected decoy values.\n- numeric version 1.2.3',
  ])('admits inert dotted output prose without treating it as an action: %s', (replacement) => {
    const prompt = LIVE_TEST07_MANDATORY_RESEARCH.replace(
      'Include rejected decoy values.',
      replacement,
    );
    expect(parseMandatoryContextEvidenceResearch(prompt)).not.toBeNull();
  });

  it('recognizes the exact live same-chat prior-pointer continuation', () => {
    expect(parseDirectContextEvidenceContinuation(LIVE_TEST07_PRIOR_POINTER_CONTINUATION)).toEqual({
      operation: 'expand',
      evidenceCount: 6,
      sources: [
        'shard-0000.txt',
        'shard-0025.txt',
        'shard-0047.txt',
        'shard-0048.txt',
        'shard-0063.txt',
        'shard-0095.txt',
      ],
      beforeBytes: 256,
      afterBytes: 0,
    });
  });

  it.each(['do not', "don't", 'never', 'avoid', 'without'])(
    'does not invert an adjacent %s expand negation into direct authority',
    (negation) => {
      expect(
        parseDirectContextEvidenceContinuation(
          LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace(
            'make exactly six vibespace_context expand calls',
            `${negation} make exactly six vibespace_context expand calls`,
          ),
        ),
      ).toBeNull();
    },
  );

  it('rejects a negated mandatory expansion and a conflicting affirmative operation', () => {
    expect(
      parseMandatoryContextEvidenceResearch(
        LIVE_TEST07_MANDATORY_RESEARCH.replace(
          'Then make exactly six expand calls',
          'Then do not make exactly six expand calls',
        ),
      ),
    ).toBeNull();
    expect(
      parseMandatoryContextEvidenceResearch(
        `${LIVE_TEST07_MANDATORY_RESEARCH}\nAlso make exactly one open call.`,
      ),
    ).toBeNull();
  });

  it.each(['seven', '999999'])(
    'retains an invalid appended %s-call count as a mandatory/direct conflict',
    (count) => {
      const conflict = `Also make exactly ${count} expand calls.`;
      expect(
        parseMandatoryContextEvidenceResearch(`${LIVE_TEST07_MANDATORY_RESEARCH}\n${conflict}`),
      ).toBeNull();
      expect(
        parseDirectContextEvidenceContinuation(
          `${LIVE_TEST07_PRIOR_POINTER_CONTINUATION}\n${conflict}`,
        ),
      ).toBeNull();
    },
  );

  it.each(['open', 'search', 'address'])(
    'rejects a conflicting affirmative %s call count in an expand continuation',
    (operation) => {
      expect(
        parseDirectContextEvidenceContinuation(
          `${LIVE_TEST07_PRIOR_POINTER_CONTINUATION}\nAlso make exactly one ${operation} call.`,
        ),
      ).toBeNull();
    },
  );

  it('admits one exact prior-pointer open continuation without granting a new search', () => {
    expect(
      parseDirectContextEvidenceContinuation(
        'Using only the exact prior Q2 pointer already present in this chat, make exactly one vibespace_context open call with maxBytes=4096. Do not call search, expand, address, or any other tool.',
      ),
    ).toEqual({
      operation: 'open',
      evidenceCount: 1,
      sources: [],
      maxBytes: 4096,
    });
  });

  it.each([
    'Explain how prior-pointer expand calls work.',
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('make exactly six', 'do not make six'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('exact six search-result pointers', 'six files'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('beforeBytes=256', 'beforeBytes=0'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('beforeBytes=256', 'beforeBytes=2049'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('afterBytes=0', 'afterBytes=-1'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('exactly six', 'exactly seven'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace(
      'exact six search-result pointers',
      'exact five search-result pointers',
    ),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('shard-0095.txt', 'shard-0095.txt.evil'),
    LIVE_TEST07_PRIOR_POINTER_CONTINUATION.replace('shard-0095.txt', 'shard-0000.txt'),
    `${LIVE_TEST07_PRIOR_POINTER_CONTINUATION}\nAlso make exactly one open call.`,
    `${LIVE_TEST07_PRIOR_POINTER_CONTINUATION}\u0000`,
    `Using only exact prior pointers already returned in this chat, make exactly six vibespace_context expand calls. Do not call search. ${'x'.repeat(32_769)}`,
  ])('rejects unsafe or ambiguous prior-pointer continuation: %s', (prompt) => {
    expect(parseDirectContextEvidenceContinuation(prompt)).toBeNull();
  });

  it.each([
    LIVE_TEST07_MANDATORY_RESEARCH.replace('exactly six expand calls', 'exactly five expand calls'),
    LIVE_TEST07_MANDATORY_RESEARCH.replace('beforeBytes=256', 'beforeBytes=0'),
    LIVE_TEST07_MANDATORY_RESEARCH.replace('beforeBytes=256', 'beforeBytes=128'),
    LIVE_TEST07_MANDATORY_RESEARCH.replace('afterBytes=0', 'afterBytes=4096'),
    LIVE_TEST07_MANDATORY_RESEARCH.replace('Search previews are not sufficient evidence.', ''),
    LIVE_TEST07_MANDATORY_RESEARCH.replace('shard-0095.txt', 'shard-0000.txt'),
  ])('rejects malformed mandatory research intent: %s', (prompt) => {
    expect(parseMandatoryContextEvidenceResearch(prompt)).toBeNull();
  });
});

describe('requestsReadOnlyContextTool', () => {
  it('does not rewrite an explicit files.read of absolute disk paths into Context search', () => {
    expect(
      requestsReadOnlyContextTool(
        'Please read them with the real files.read action.\nC:\\Users\\viper\\Downloads\\proof.txt',
      ),
    ).toBe(false);
  });
});
