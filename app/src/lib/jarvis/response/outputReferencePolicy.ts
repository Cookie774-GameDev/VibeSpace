import type { JarvisSourceRef } from '@/lib/jarvis/contracts';
import { findJarvisDisplayLinks } from './referenceParser';
import { findUnsafeSpeechReferences } from './spokenDelivery';
import {
  jarvisRegionPlaceholder,
  type JarvisStructuredRegion,
  type TokenizedJarvisResponse,
} from './tokenizer';

const UNVERIFIED_LINK_NOTICE = '[unverified link omitted]';
const UNVERIFIED_OUTPUT_LOCATION_NOTICE = '[unverified output location omitted]';
const OUTPUT_NOUN =
  /\b(?:artifact|download|export|file|image|output|report|result|video|audio|document|archive)\b/i;
const OUTPUT_ASSERTION =
  /\b(?:available|copied|created|downloaded|exported|find it|generated|here it is|left|located|location is|moved|opened|placed|published|put|ready|rendered|saved|stored|uploaded|written)\b/i;
const OUTPUT_ACCESS = /\b(?:access|download|find|open|view)\b/i;
const DIRECT_OUTPUT_ACTION =
  /\b(?:available|access|cop(?:y|ied|ies|ying)|creat(?:e|ed|es|ing)|download(?:ed|s|ing)?|export(?:ed|s|ing)?|find(?:s|ing)?\s+it|generat(?:e|ed|es|ing)|here\s+it\s+is|left|locat(?:e|ed|es|ing)|location\s+is|mov(?:e|ed|es|ing)|open(?:ed|s|ing)?|place[ds]?|produced?|publish(?:ed|es|ing)?|put|read(?:y|ied)?|render(?:ed|s|ing)?|sav(?:e|ed|es|ing)|stor(?:e|ed|es|ing)|upload(?:ed|s|ing)?|view(?:ed|s|ing)?|writ(?:e|ten|es|ing))\s*$/i;
const DIRECT_OUTPUT_NOUN_ACTION =
  /\b(?:available|access|cop(?:y|ied|ies|ying)|creat(?:e|ed|es|ing)|download(?:ed|s|ing)?|export(?:ed|s|ing)?|generat(?:e|ed|es|ing)|locat(?:e|ed|es|ing)|mov(?:e|ed|es|ing)|open(?:ed|s|ing)?|place[ds]?|produced?|publish(?:ed|es|ing)?|put|render(?:ed|s|ing)?|sav(?:e|ed|es|ing)|stor(?:e|d|es|ing)|upload(?:ed|s|ing)?|writ(?:e|ten|es|ing))\s+(?:the\s+|a\s+|an\s+)?(?:new\s+|completed\s+|final\s+)?(?:file|output|report|result|artifact|document)\s*$/i;
const DIRECT_LOCATION_CONNECTOR = /\b(?:at|in|into|to|under|inside|within)\s*$/i;
const DIRECT_PRODUCED_LOCATION = /\bproduced\s+(?:at|in|to)\s+[`"'(]*$/i;
const REVERSE_OUTPUT_ACTION =
  /^\s+(?:(?:was|is|has\s+been|had\s+been|will\s+be)\s+)?(?:available|cop(?:y|ied|ies|ying)|creat(?:e|ed|es|ing)|download(?:ed|s|ing)?|export(?:ed|s|ing)?|generat(?:e|ed|es|ing)|left|locat(?:e|ed|es|ing)|mov(?:e|ed|es|ing)|open(?:ed|s|ing)?|place[ds]?|produced?|publish(?:ed|es|ing)?|put|read(?:y|ied)?|render(?:ed|s|ing)?|sav(?:e|ed|es|ing)|stor(?:e|d|es|ing)|upload(?:ed|s|ing)?|view(?:ed|s|ing)?|writ(?:e|ten|es|ing))\b/i;
const SAFE_SOURCE_URI_PROTOCOLS = new Set([
  'app:',
  'asset:',
  'file:',
  'http:',
  'https:',
  'jarvis:',
  'tauri:',
  'vibespace:',
]);

export interface JarvisOutputReferencePolicyResult {
  proseWithPlaceholders: string;
  structuredRegions: readonly JarvisStructuredRegion[];
  violationCodes: readonly string[];
}

function canonicalReference(value: string): string {
  let trimmed = value.trim();
  const wrapper = trimmed[0];
  if (
    trimmed.length >= 2 &&
    (wrapper === '`' || wrapper === '"' || wrapper === "'") &&
    trimmed.at(-1) === wrapper
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed)) {
    return trimmed.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
  }
  if (trimmed.startsWith('/')) {
    return trimmed.replace(/\/+$/g, '');
  }
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

function isSafeSourceReference(value: string): boolean {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed) || trimmed.startsWith('/')) {
    return true;
  }
  try {
    return SAFE_SOURCE_URI_PROTOCOLS.has(new URL(trimmed).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function permittedReferences(sourceRefs: readonly JarvisSourceRef[]): ReadonlySet<string> {
  return new Set(
    sourceRefs
      .filter(
        (source) =>
          source.uri &&
          source.sensitivity !== 'restricted' &&
          source.sensitivity !== 'secret' &&
          isSafeSourceReference(source.uri),
      )
      .map((source) => canonicalReference(source.uri!)),
  );
}

function trailingPunctuationCandidate(value: string): string {
  return value.replace(/[.,;:!?]+$/u, '');
}

function structuredReferenceCandidates(region: JarvisStructuredRegion): readonly string[] {
  const target = region.referenceTarget ?? findJarvisDisplayLinks(region.bytes)[0]?.target;
  return target ? [target, trailingPunctuationCandidate(target)] : [];
}

function isPermittedReference(
  candidates: readonly string[],
  permitted: ReadonlySet<string>,
): boolean {
  return candidates.some((candidate) => permitted.has(canonicalReference(candidate)));
}

function isOutputLocationClaim(
  text: string,
  start: number,
  end: number,
  options: Readonly<{ preserveBroadAssertions?: boolean }> = {},
): boolean {
  const before = text.slice(Math.max(0, start - 96), start);
  // A move/copy source is not a claim that the assistant produced this path.
  // Keep checking the destination independently, including within the same sentence.
  const after = text.slice(end, Math.min(text.length, end + 24));
  const moveSource =
    /\b(?:mov(?:e[ds]?|ing)|cop(?:y|ies|ied|ying))\s+(?:from|out\s+of)\s+[`"']?$/iu.test(before);
  const copySource =
    /\bcop(?:y|ies|ying)\s+[`"']?$/iu.test(before) &&
    /^[`"']?\s+(?:into|to)\b/iu.test(after);
  if (moveSource || copySource) {
    return false;
  }
  // Quoted relative paths are passed here without their opening quote. Strip
  // the wrapper before checking the immediate claim so a technical token such
  // as `src/styles.css` is not treated as an output merely because `Created`
  // appears earlier in the same sentence.
  const prefix = text.slice(0, start);
  const sentencePunctuation = [...prefix.matchAll(/[.!?](?=\s)/gu)].at(-1)?.index ?? -1;
  const directBefore = text.slice(sentencePunctuation + 1, start);
  const normalizedBefore = directBefore.replace(/[`"']\s*$/u, '');
  const directClaim =
    DIRECT_OUTPUT_ACTION.test(normalizedBefore) ||
    DIRECT_OUTPUT_NOUN_ACTION.test(normalizedBefore) ||
    DIRECT_PRODUCED_LOCATION.test(directBefore) ||
    (DIRECT_LOCATION_CONNECTOR.test(normalizedBefore) && OUTPUT_ASSERTION.test(normalizedBefore)) ||
    REVERSE_OUTPUT_ACTION.test(after);
  if (directClaim) return true;
  if (!options.preserveBroadAssertions) return false;
  const local = text.slice(Math.max(0, start - 96), Math.min(text.length, end + 96));
  return OUTPUT_ASSERTION.test(local) || (OUTPUT_NOUN.test(local) && OUTPUT_ACCESS.test(local));
}

function replacementBounds(
  text: string,
  start: number,
  end: number,
): Readonly<{ start: number; end: number }> {
  const wrapper = text[start - 1];
  if ((wrapper === '`' || wrapper === '"' || wrapper === "'") && text[end] === wrapper) {
    return { start: start - 1, end: end + 1 };
  }
  return { start, end };
}

function preserveBroadRelativeOutputAssertions(candidate: string): boolean {
  const normalized = candidate.replace(/\\/gu, '/');
  if (/^\.{1,2}\//u.test(normalized) || candidate.includes('\\')) return true;

  const segments = normalized.split('/');
  const filename = segments.at(-1) ?? '';
  if (/\.[A-Za-z0-9]{1,8}$/u.test(filename)) {
    return true;
  }

  return /^(?:artifact|artifacts|download|downloads|export|exports|out|output|outputs|report|reports|result|results)(?:\/|$)/iu.test(
    normalized,
  );
}

function overlaps(
  left: Readonly<{ start: number; end: number }>,
  right: Readonly<{ start: number; end: number }>,
): boolean {
  return left.start < right.end && left.end > right.start;
}

function findRelativeOutputLocations(
  prose: string,
): readonly Readonly<{ start: number; end: number }>[] {
  const locations: Array<{ start: number; end: number }> = [];
  const quotedPath = /`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'/gu;
  for (const match of prose.matchAll(quotedPath)) {
    const bytes = match[1] ?? match[2] ?? match[3];
    if (
      !bytes ||
      /^[A-Za-z]:[\\/]/u.test(bytes) ||
      /^[/\\]{2}/u.test(bytes) ||
      bytes.startsWith('/') ||
      !/^(?:\.{1,2}[\\/]|[^\\/]+[\\/]).+/u.test(bytes)
    ) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].indexOf(bytes);
    locations.push(Object.freeze({ start, end: start + bytes.length }));
  }

  const relativePath =
    /(?:^|[\s([{"'`])((?:\.{1,2}[\\/]|[A-Za-z0-9._-]+[\\/])(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+)(?=$|[\s)\]},;:!?"'`])/gmu;
  for (const match of prose.matchAll(relativePath)) {
    const bytes = match[1];
    if (!bytes) continue;
    const start = (match.index ?? 0) + match[0].indexOf(bytes);
    const location = Object.freeze({ start, end: start + bytes.length });
    if (!locations.some((existing) => overlaps(existing, location))) {
      locations.push(location);
    }
  }
  locations.sort((left, right) => left.start - right.start || left.end - right.end);
  return Object.freeze(locations);
}

function filterDirectReferences(
  prose: string,
  permitted: ReadonlySet<string>,
): Readonly<{ prose: string; violationCodes: readonly string[] }> {
  const replacements: Array<{
    start: number;
    end: number;
    notice: string;
    code: string;
  }> = [];
  let linkIndex = 0;
  let locationIndex = 0;

  for (const link of findJarvisDisplayLinks(prose)) {
    if (isPermittedReference([link.target], permitted)) continue;
    replacements.push({
      start: link.start,
      end: link.end,
      notice: UNVERIFIED_LINK_NOTICE,
      code: `unverified_output_reference:direct-${linkIndex++}`,
    });
  }

  for (const reference of findUnsafeSpeechReferences(prose)) {
    if (reference.kind === 'link') continue;
    if (replacements.some((replacement) => overlaps(reference, replacement))) continue;
    const candidate = prose.slice(reference.start, reference.end);
    if (isPermittedReference([candidate], permitted)) continue;
    if (
      !isOutputLocationClaim(prose, reference.start, reference.end, {
        preserveBroadAssertions: true,
      })
    ) {
      continue;
    }
    const bounds = replacementBounds(prose, reference.start, reference.end);
    replacements.push({
      ...bounds,
      notice: UNVERIFIED_OUTPUT_LOCATION_NOTICE,
      code: `unverified_output_location:${locationIndex++}`,
    });
  }

  for (const location of findRelativeOutputLocations(prose)) {
    if (replacements.some((replacement) => overlaps(location, replacement))) continue;
    const candidate = prose.slice(location.start, location.end);
    if (isPermittedReference([candidate], permitted)) continue;
    if (
      !isOutputLocationClaim(prose, location.start, location.end, {
        preserveBroadAssertions: preserveBroadRelativeOutputAssertions(candidate),
      })
    ) {
      continue;
    }
    const bounds = replacementBounds(prose, location.start, location.end);
    replacements.push({
      ...bounds,
      notice: UNVERIFIED_OUTPUT_LOCATION_NOTICE,
      code: `unverified_output_location:${locationIndex++}`,
    });
  }

  replacements.sort((left, right) => left.start - right.start || left.end - right.end);
  let filtered = prose;
  for (const replacement of [...replacements].reverse()) {
    filtered =
      filtered.slice(0, replacement.start) + replacement.notice + filtered.slice(replacement.end);
  }
  return {
    prose: filtered,
    violationCodes: Object.freeze(replacements.map((replacement) => replacement.code)),
  };
}

export function enforceJarvisOutputReferencePolicy(
  tokenized: Readonly<TokenizedJarvisResponse>,
  sourceRefs: readonly JarvisSourceRef[],
): Readonly<JarvisOutputReferencePolicyResult> {
  const permitted = permittedReferences(sourceRefs);
  const violationCodes: string[] = [];
  const structuredRegions: JarvisStructuredRegion[] = [];
  let prose = tokenized.proseWithPlaceholders;

  for (const region of tokenized.regions) {
    if (!region.valid) continue;
    if (region.kind !== 'url' && region.kind !== 'citation') {
      structuredRegions.push(region);
      continue;
    }
    if (isPermittedReference(structuredReferenceCandidates(region), permitted)) {
      structuredRegions.push(region);
      continue;
    }
    prose = prose.replace(jarvisRegionPlaceholder(region.index), UNVERIFIED_LINK_NOTICE);
    violationCodes.push(`unverified_output_reference:${region.index}`);
  }

  const direct = filterDirectReferences(prose, permitted);
  violationCodes.push(...direct.violationCodes);
  return Object.freeze({
    proseWithPlaceholders: direct.prose,
    structuredRegions: Object.freeze(structuredRegions),
    violationCodes: Object.freeze(violationCodes),
  });
}
