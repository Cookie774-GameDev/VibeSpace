const EXPLICIT_CONTEXT_TOOL = /\b(?:vibespace_context|context map)\b/i;
const MUTATING_REQUEST =
  /\b(?:write|create|save|delete|remove|rename|move|edit|modify|change|run|execute|launch|start|command|terminal)\b/i;
const READ_OR_EVIDENCE_REQUEST =
  /\b(?:read|search|find|look\s+up|answer|quote|cite|citation|source|where\s+(?:you|u)\s+found)\b/i;
const FILE_LIKE_SOURCE = /\b(?:files?|documents?|corpus|records?|sources?|literature)\b/i;
const MAX_DIRECT_CONTEXT_REQUEST_CHARS = 32_768;
const UNSAFE_DIRECT_CONTEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const DIRECT_ADDRESS_ONLY = /\bvibespace_context\b[ \t]+address[ \t]+operation[ \t]+only\b/iu;
const DIRECT_OTHER_DOTTED =
  /\bvibespace_context\s*\.\s*(?:describe|checkpoint|search|open|expand|related|investigate)\b/iu;
const DIRECT_OTHER_OPERATION =
  /\boperation\s*(?:=|:)\s*["'`]?(?:describe|checkpoint|search|open|expand|related|investigate)["'`]?\b/iu;
const NEGATED_INVOCATION =
  /\b(?:do\s+not|don't|never|avoid|without)\s+(?:call|calling|invoke|invoking|use|using|make|making|perform|performing)\b/giu;
const NO_ADDRESS_CALLS =
  /\bno\b[^\r\n]{0,160}\bvibespace_context\b[^\r\n]{0,160}\baddress\s+calls?\b/iu;
const DESCRIPTIVE_DIRECT_ADDRESS =
  /^\s*(?:please\s+)?(?:explain|describe|document|tell\s+me\s+about|what\s+is|is|does)\b/iu;
const DIRECT_CALL_VERB = /\b(?:call|invoke|use|make|perform)\b/iu;
const ADDRESS_CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/u;
const CANONICAL_ADDRESS_POSITION = /^(?:0|[1-9]\d*)$/u;
const MAX_ADDRESS_POSITION = '10000000000000000';
const MAX_ADDRESS_CALLS = 12;
const MAX_EVIDENCE_CALLS = 6;
const MAX_MANDATORY_OUTPUT_SUFFIX_CHARS = 8_192;
const CONTEXT_SOURCE_LEAF = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}\.txt$/u;
const CONTEXT_SOURCE_LEAF_IN_TEXT = /[A-Za-z0-9][A-Za-z0-9._@-]{0,199}\.txt/gu;
const MANDATORY_OUTPUT_MARKER = 'OUTPUT ONLY AFTER ALL 11 REQUIRED CALLS';
const MANDATORY_OUTPUT_LINE = /^(?:Return|Include|List|End|If|For each|Q3|Do not)\b|^-[ \t]+\S/iu;
const MANDATORY_OUTPUT_AUTHORITY_ATTEMPT =
  /(?:^|[.,;:][ \t]+|\b(?:and|or)[ \t]+)(?:-[ \t]+)?(?:(?:please|kindly|also|then)[ \t]+)*(?:call|search|use|perform|invoke|make|emit|execute|run|create|write|delete|edit)\b/imu;
const MANDATORY_OUTPUT_AUTHORITY_SYNTAX =
  /["'`]?operation["'`]?\s*[:=]\s*["'`](?:search|open|expand|address)["'`]|\btool_?call\b|```(?:action|tool)\b/iu;
const MANDATORY_OUTPUT_DOTTED_IDENTIFIER =
  /\b[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+\b/gu;
const MANDATORY_OUTPUT_SAFE_PHYSICAL_FILENAME = /^shard-\d{4}\.txt$/u;
const MANDATORY_OUTPUT_SAFE_VERSION = /^[A-Za-z][A-Za-z0-9_-]{0,63}\.v\d+$/u;
const MANDATORY_OUTPUT_SAFE_DOTTED_PROSE = new Set(['example.value']);

function hasUnsafeMandatoryOutputDottedIdentifier(value: string): boolean {
  return [...value.matchAll(MANDATORY_OUTPUT_DOTTED_IDENTIFIER)].some((match) => {
    const token = match[0];
    return (
      !MANDATORY_OUTPUT_SAFE_PHYSICAL_FILENAME.test(token) &&
      !MANDATORY_OUTPUT_SAFE_VERSION.test(token) &&
      !MANDATORY_OUTPUT_SAFE_DOTTED_PROSE.has(token)
    );
  });
}
export const MANDATORY_CONTEXT_EVIDENCE_DIRECTIVE_MARKER =
  '## Validated mandatory Context physical-evidence contract';
const ADDRESS_JSON_OBJECT = /\{[^{}\r\n]{1,512}\}/gu;
const ADDRESS_JSON_KEY = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/gu;
const ADDRESS_BULLET =
  /^[ \t]*-[ \t]+([A-Za-z0-9][A-Za-z0-9._@-]{0,199})[ \t]+@[ \t]+(0|[1-9]\d*)[ \t]*$/gmu;
const ANY_BULLET_LINE = /^[ \t]*-[ \t]+.*$/gmu;
const DECLARED_CALL_COUNT =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|\d{1,2})\s+(?:address\s+)?calls?\b/giu;
const EXACTLY_ONCE = /\bexactly\s+once\b/iu;
const TWICE = /\btwice\b/iu;

const CALL_COUNT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
});

interface DirectAddressTuple {
  corpusId: string;
  position: string;
}

export interface MandatoryContextEvidenceResearch {
  readonly questionCount: 5;
  readonly operation: 'expand';
  readonly evidenceCount: number;
  readonly sources: readonly string[];
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly maxTotalBytes: 24_576;
  readonly outputSuffix: string;
}

export type DirectContextEvidenceContinuation =
  | Readonly<{
      operation: 'expand';
      evidenceCount: number;
      sources: readonly string[];
      beforeBytes?: number;
      afterBytes?: number;
    }>
  | Readonly<{
      operation: 'open';
      evidenceCount: 1;
      sources: readonly [];
      maxBytes: 4096;
    }>;

function boundedDirectContextText(userText: string): boolean {
  return (
    userText.length > 0 &&
    userText.length <= MAX_DIRECT_CONTEXT_REQUEST_CHARS &&
    !UNSAFE_DIRECT_CONTEXT_CONTROL.test(userText)
  );
}

function countFromText(value: string): number | undefined {
  const normalized = value.toLowerCase();
  const count = CALL_COUNT_WORDS[normalized] ?? Number(normalized);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_EVIDENCE_CALLS
    ? count
    : undefined;
}

interface ContextCallCount {
  readonly operation: 'open' | 'expand' | 'search' | 'address';
  readonly count: number | null;
}

function hasNegatedContextCallCount(userText: string): boolean {
  return /\b(?:(?:do\s+not|don't|never)\s+(?:make|call|invoke|use|perform)|(?:avoid|without)\s+(?:make|making|call|calling|invoke|invoking|use|using|perform|performing))\s+exactly\s+(?:[A-Za-z]+|\d+)\s+(?:vibespace_context\s+)?(?:open|expand|search|address)\s+calls?\b/iu.test(
    userText,
  );
}

function affirmativeContextCallCounts(userText: string): readonly ContextCallCount[] {
  return [
    ...userText.matchAll(
      /\bmake exactly\s+([A-Za-z]+|\d+)\s+(?:vibespace_context\s+)?(open|expand|search|address)\s+calls?\b/giu,
    ),
  ].flatMap((match) => {
    const count = match[1] ? countFromText(match[1]) : undefined;
    const operation = match[2]?.toLowerCase();
    return operation === 'open' ||
      operation === 'expand' ||
      operation === 'search' ||
      operation === 'address'
      ? [{ count: count ?? null, operation }]
      : [];
  });
}

function parseDirection(userText: string, name: 'beforeBytes' | 'afterBytes'): number | undefined {
  const matches = [
    ...userText.matchAll(new RegExp(`\\b${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\b`, 'giu')),
  ];
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) return Number.NaN;
  const value = Number(matches[0]?.[1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 2048 ? value : Number.NaN;
}

function validExpansionDirections(
  beforeBytes: number | undefined,
  afterBytes: number | undefined,
): boolean {
  return (
    !Number.isNaN(beforeBytes) &&
    !Number.isNaN(afterBytes) &&
    (beforeBytes === undefined || (beforeBytes >= 0 && beforeBytes <= 2048)) &&
    (afterBytes === undefined || (afterBytes >= 0 && afterBytes <= 2048)) &&
    (beforeBytes !== undefined || afterBytes !== undefined) &&
    ((beforeBytes ?? 0) > 0 || (afterBytes ?? 0) > 0)
  );
}

function exactUniqueSources(sourceText: string, expectedCount: number): readonly string[] | null {
  if (/[\\/]/u.test(sourceText)) return null;
  const sources = sourceText.match(CONTEXT_SOURCE_LEAF_IN_TEXT) ?? [];
  const residue = sourceText
    .replace(CONTEXT_SOURCE_LEAF_IN_TEXT, '')
    .replace(/\band\b/giu, '')
    .replace(/[,\s]/gu, '');
  if (
    residue.length > 0 ||
    sources.length !== expectedCount ||
    new Set(sources).size !== sources.length ||
    sources.some((source) => !CONTEXT_SOURCE_LEAF.test(source))
  ) {
    return null;
  }
  return Object.freeze([...sources]);
}

function exactMandatoryOutputSuffix(userText: string): string | null {
  const rawMarkers = [...userText.matchAll(new RegExp(MANDATORY_OUTPUT_MARKER, 'gu'))];
  const lineMarkers = [...userText.matchAll(new RegExp(`^${MANDATORY_OUTPUT_MARKER}$`, 'gmu'))];
  if (rawMarkers.length !== 1 || lineMarkers.length !== 1 || lineMarkers[0]?.index === undefined) {
    return null;
  }
  const markerIndex = lineMarkers[0].index;
  const stageTwoIndex = userText.indexOf('STAGE 2 — REQUIRED PHYSICAL EVIDENCE');
  const questionsIndex = userText.indexOf('QUESTIONS');
  const fifthQuestion = userText.match(/^[ \t]*5\.[ \t]+\S[^\r\n]*$/mu);
  const fifthQuestionIndex = fifthQuestion?.index ?? -1;
  const fifthQuestionEnd = fifthQuestionIndex + (fifthQuestion?.[0].length ?? 0);
  if (
    stageTwoIndex < 0 ||
    questionsIndex < stageTwoIndex ||
    fifthQuestionIndex < questionsIndex ||
    markerIndex <= fifthQuestionEnd ||
    !/^(?:\r?\n)+$/u.test(userText.slice(fifthQuestionEnd, markerIndex))
  ) {
    return null;
  }
  const suffix = userText.slice(markerIndex);
  if (suffix.length > MAX_MANDATORY_OUTPUT_SUFFIX_CHARS) return null;
  const outputLines = suffix.split(/\r?\n/u).slice(1);
  const nonemptyOutputLines = outputLines.filter((line) => line.trim().length > 0);
  const outputText = outputLines.join('\n');
  if (
    nonemptyOutputLines.length === 0 ||
    !nonemptyOutputLines.every((line) => MANDATORY_OUTPUT_LINE.test(line)) ||
    MANDATORY_OUTPUT_AUTHORITY_ATTEMPT.test(outputText) ||
    MANDATORY_OUTPUT_AUTHORITY_SYNTAX.test(outputText) ||
    hasUnsafeMandatoryOutputDottedIdentifier(outputText)
  ) {
    return null;
  }
  return suffix;
}

export function parseMandatoryContextEvidenceResearch(
  userText: string,
): MandatoryContextEvidenceResearch | null {
  const callCounts = affirmativeContextCallCounts(userText);
  if (
    !boundedDirectContextText(userText) ||
    hasNegatedContextCallCount(userText) ||
    callCounts.length !== 2 ||
    !callCounts.some(({ operation, count }) => operation === 'search' && count === 5) ||
    !callCounts.some(({ operation, count }) => operation === 'expand' && count === 6) ||
    !/\bSTAGE 1\s+—\s+REQUIRED SEARCHES\b/u.test(userText) ||
    !/\bSTAGE 2\s+—\s+REQUIRED PHYSICAL EVIDENCE\b/u.test(userText) ||
    !/\bMake exactly five search calls\b/iu.test(userText) ||
    !/\beach with limit 3\b/iu.test(userText) ||
    !/\bSearch previews are not sufficient evidence\b/iu.test(userText) ||
    !/\bmake exactly six expand calls\b/iu.test(userText) ||
    !/\bThese six expand calls are mandatory\b/iu.test(userText) ||
    !/\bDo not call open, address, or any other tool\b/iu.test(userText) ||
    !/\bTotal expanded physical text must be <=24 KiB\b/iu.test(userText)
  ) {
    return null;
  }
  const questions = userText.match(/^\s*[1-5]\.\s+\S.+$/gmu) ?? [];
  if (questions.length !== 5) return null;
  const sourceClause = userText.match(
    /\bexact six required sources:\s*([^\r\n]+?)\.\s+Then make exactly six expand calls\b/iu,
  )?.[1];
  if (!sourceClause) return null;
  const sources = exactUniqueSources(sourceClause, 6);
  if (!sources) return null;
  const beforeBytes = parseDirection(userText, 'beforeBytes');
  const afterBytes = parseDirection(userText, 'afterBytes');
  if (
    !validExpansionDirections(beforeBytes, afterBytes) ||
    beforeBytes !== 256 ||
    afterBytes !== 0
  ) {
    return null;
  }
  const outputSuffix = exactMandatoryOutputSuffix(userText);
  if (!outputSuffix) return null;
  return Object.freeze({
    questionCount: 5,
    operation: 'expand',
    evidenceCount: 6,
    sources,
    beforeBytes,
    afterBytes,
    maxTotalBytes: 24_576,
    outputSuffix,
  });
}

export function parseDirectContextEvidenceContinuation(
  userText: string,
): DirectContextEvidenceContinuation | null {
  const countedPriorPointers = userText.match(
    /\bexact\s+(one|two|three|four|five|six|\d+)\s+search-result pointers?\s+(?:already returned|already present) in this chat\b/iu,
  );
  const singularPriorPointer =
    /\bexact prior [A-Za-z0-9_-]+ pointer\s+(?:already returned|already present) in this chat\b/iu.test(
      userText,
    );
  if (
    !boundedDirectContextText(userText) ||
    hasNegatedContextCallCount(userText) ||
    (!countedPriorPointers && !singularPriorPointer) ||
    !/\b(?:Do not repeat any search|Do not call [^.\r\n]*\bsearch\b|no new search)\b/iu.test(
      userText,
    )
  ) {
    return null;
  }
  const request = userText.match(
    /\bmake exactly\s+(one|two|three|four|five|six|\d+)\s+vibespace_context\s+(expand|open)\s+calls?\b/iu,
  );
  if (!request?.[1] || !request[2]) return null;
  const evidenceCount = countFromText(request[1]);
  if (!evidenceCount) return null;
  const operation = request[2].toLowerCase() as 'expand' | 'open';
  const priorPointerCount = countedPriorPointers?.[1]
    ? countFromText(countedPriorPointers[1])
    : singularPriorPointer
      ? 1
      : undefined;
  if (priorPointerCount !== evidenceCount) return null;
  const affirmativeEvidenceRequests = affirmativeContextCallCounts(userText);
  if (
    affirmativeEvidenceRequests.length !== 1 ||
    affirmativeEvidenceRequests[0]?.operation !== operation ||
    affirmativeEvidenceRequests[0]?.count !== evidenceCount
  ) {
    return null;
  }
  if (operation === 'open') {
    if (
      evidenceCount !== 1 ||
      !/\bmaxBytes\s*=\s*4096\b/u.test(userText) ||
      /\b(?:beforeBytes|afterBytes)\s*=/u.test(userText)
    ) {
      return null;
    }
    return Object.freeze({
      operation,
      evidenceCount: 1,
      sources: Object.freeze([] as const),
      maxBytes: 4096,
    });
  }
  const sourceClause = userText.match(
    /\balready returned in this chat for\s+(.+?),\s+make exactly\b/iu,
  )?.[1];
  if (!sourceClause) return null;
  const sources = exactUniqueSources(sourceClause, evidenceCount);
  if (!sources) return null;
  const beforeBytes = parseDirection(userText, 'beforeBytes');
  const afterBytes = parseDirection(userText, 'afterBytes');
  if (!validExpansionDirections(beforeBytes, afterBytes)) return null;
  return Object.freeze({
    operation,
    evidenceCount,
    sources,
    ...(beforeBytes === undefined ? {} : { beforeBytes }),
    ...(afterBytes === undefined ? {} : { afterBytes }),
  });
}

function boundedAddressPosition(value: string): boolean {
  if (!CANONICAL_ADDRESS_POSITION.test(value)) return false;
  return (
    value.length < MAX_ADDRESS_POSITION.length ||
    (value.length === MAX_ADDRESS_POSITION.length && value <= MAX_ADDRESS_POSITION)
  );
}

function declaredAddressCallCount(userText: string): number | null | undefined {
  const counts: number[] = [];
  for (const match of userText.matchAll(DECLARED_CALL_COUNT)) {
    const raw = match[1]?.toLowerCase();
    if (!raw) return undefined;
    counts.push(CALL_COUNT_WORDS[raw] ?? Number(raw));
  }
  if (EXACTLY_ONCE.test(userText)) counts.push(1);
  if (TWICE.test(userText)) counts.push(2);
  if (counts.length === 0) return null;
  return counts.every((count) => count === counts[0]) ? counts[0] : undefined;
}

function uniqueBoundedAddressTuples(tuples: readonly DirectAddressTuple[]): boolean {
  if (tuples.length === 0 || tuples.length > MAX_ADDRESS_CALLS) return false;
  const identities = new Set(
    tuples.map(({ corpusId, position }) => `${corpusId}\u0000${position}`),
  );
  return identities.size === tuples.length;
}

function explicitlyNegatesAddressInvocation(userText: string): boolean {
  if (NO_ADDRESS_CALLS.test(userText)) return true;
  for (const match of userText.matchAll(NEGATED_INVOCATION)) {
    const target = userText.slice(
      (match.index ?? 0) + match[0].length,
      userText.indexOf('\n', match.index ?? 0) >= 0
        ? userText.indexOf('\n', match.index ?? 0)
        : Math.min(userText.length, (match.index ?? 0) + match[0].length + 320),
    );
    if (
      /\baddress\s+(?:operation|calls?)\b/iu.test(target) ||
      (/\bvibespace_context\b/iu.test(target) && /\baddress\b/iu.test(target))
    ) {
      return true;
    }
  }
  return false;
}

function parseAddressJsonTuple(raw: string): DirectAddressTuple | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = [...raw.matchAll(ADDRESS_JSON_KEY)].map((match) => match[1]);
  if (
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    Object.keys(record).length !== 3 ||
    record.operation !== 'address' ||
    typeof record.corpusId !== 'string' ||
    !ADDRESS_CORPUS_ID.test(record.corpusId) ||
    typeof record.position !== 'string' ||
    !boundedAddressPosition(record.position)
  ) {
    return null;
  }
  if (!keys.every((key) => key === 'operation' || key === 'corpusId' || key === 'position')) {
    return null;
  }
  return Object.freeze({ corpusId: record.corpusId, position: record.position });
}

function exactJsonAddressTuples(userText: string): readonly DirectAddressTuple[] | null {
  const rawObjects = [...userText.matchAll(ADDRESS_JSON_OBJECT)].map((match) => match[0]);
  if (rawObjects.length === 0 || (userText.match(ANY_BULLET_LINE)?.length ?? 0) > 0) return null;
  const textWithoutObjects = rawObjects.reduce((text, raw) => text.replace(raw, ''), userText);
  if (/[{}]/u.test(textWithoutObjects)) return null;
  const tuples = rawObjects.map(parseAddressJsonTuple);
  return tuples.every((tuple): tuple is DirectAddressTuple => tuple !== null) ? tuples : null;
}

function exactBulletAddressTuples(userText: string): readonly DirectAddressTuple[] | null {
  if (!DIRECT_ADDRESS_ONLY.test(userText) || /[{}]/u.test(userText)) return null;
  const bulletLines = userText.match(ANY_BULLET_LINE) ?? [];
  const tuples = [...userText.matchAll(ADDRESS_BULLET)].map((match) => ({
    corpusId: match[1]!,
    position: match[2]!,
  }));
  if (
    bulletLines.length === 0 ||
    tuples.length !== bulletLines.length ||
    tuples.some(
      ({ corpusId, position }) =>
        !ADDRESS_CORPUS_ID.test(corpusId) || !boundedAddressPosition(position),
    )
  ) {
    return null;
  }
  return tuples;
}

/**
 * Selects the bounded, read-only Context Map tool for explicit tool requests
 * and natural requests that ask for answers or evidence from file-like sources.
 * Mixed read/write requests retain the normal tool catalog so this classifier
 * never silently removes capabilities needed to satisfy an authorized mutation.
 */
export function requestsReadOnlyContextTool(userText: string): boolean {
  if (EXPLICIT_CONTEXT_TOOL.test(userText)) return true;
  if (MUTATING_REQUEST.test(userText)) return false;
  // Registered disk reads must stay on files.read, not Context-map search.
  if (/\bfiles\.read\b/i.test(userText) && /[A-Za-z]:[\\/]/.test(userText)) return false;
  return READ_OR_EVIDENCE_REQUEST.test(userText) && FILE_LIKE_SOURCE.test(userText);
}

/**
 * Recognizes only an affirmative, explicit request to invoke the bounded
 * Context Map address operation. It never extracts or normalizes arguments;
 * callers use this signal solely to preserve the user's exact provider text.
 */
export function requestsDirectContextAddress(userText: string): boolean {
  if (
    userText.length === 0 ||
    userText.length > MAX_DIRECT_CONTEXT_REQUEST_CHARS ||
    UNSAFE_DIRECT_CONTEXT_CONTROL.test(userText) ||
    !/\bvibespace_context\b/iu.test(userText) ||
    explicitlyNegatesAddressInvocation(userText) ||
    DESCRIPTIVE_DIRECT_ADDRESS.test(userText) ||
    !DIRECT_CALL_VERB.test(userText) ||
    DIRECT_OTHER_DOTTED.test(userText) ||
    DIRECT_OTHER_OPERATION.test(userText)
  ) {
    return false;
  }
  const tuples = exactJsonAddressTuples(userText) ?? exactBulletAddressTuples(userText);
  if (!tuples || !uniqueBoundedAddressTuples(tuples)) return false;
  const declaredCount = declaredAddressCallCount(userText);
  return declaredCount !== undefined && (declaredCount === null || declaredCount === tuples.length);
}
