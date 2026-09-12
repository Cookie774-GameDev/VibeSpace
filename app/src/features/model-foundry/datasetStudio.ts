import type { DatasetExample, DatasetVersionManifest } from './domain';
import { CURRENT_FOUNDRY_SCHEMA_VERSION, validateDatasetVersion } from './validation';

export type DatasetImportFormat = 'jsonl' | 'json' | 'csv' | 'markdown';
export type DatasetExampleType = DatasetExample['exampleType'];
export type DatasetSourceKind = DatasetExample['source']['kind'];

export interface DatasetDraft {
  readonly input: string;
  readonly expectedOutput: string;
  readonly exampleType: DatasetExampleType;
  readonly sourceKind: DatasetSourceKind;
  readonly sourceReference: string;
  readonly license: string;
  readonly privacyClassification: DatasetExample['privacyClassification'];
  readonly tags: readonly string[];
  /** Locally generated template variation; never confused with a human source. */
  readonly synthetic?: boolean;
  readonly syntheticProvenance?: string;
}

export interface CsvMapping {
  readonly inputColumn: string;
  readonly outputColumn: string;
  readonly typeColumn?: string;
}

export interface ScanFinding {
  readonly kind: 'api_key' | 'jwt' | 'private_key' | 'connection_string' | 'password' | 'session' | 'seed_phrase' | 'email' | 'phone' | 'payment_card' | 'private_path';
  readonly severity: 'secret' | 'personal';
  readonly start: number;
  readonly end: number;
}

export interface DatasetBuildOptions {
  readonly projectId: string;
  readonly datasetId: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly actorId: string;
  readonly consentApproved: boolean;
  readonly consentPurpose: string;
  readonly now: string;
  readonly seed: number;
}

export interface DatasetBuildResult {
  readonly manifest: DatasetVersionManifest;
  readonly quarantined: readonly { readonly draftIndex: number; readonly findingKinds: readonly string[] }[];
  readonly duplicateGroups: readonly { readonly normalizedHash: string; readonly draftIndexes: readonly number[] }[];
}

const SECRET_PATTERNS: readonly { kind: ScanFinding['kind']; pattern: RegExp }[] = [
  { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: 'api_key', pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|whsec_[A-Za-z0-9_-]{16,})\b/g },
  { kind: 'connection_string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi },
  { kind: 'password', pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]{6,}/gi },
  { kind: 'session', pattern: /\b(?:session|cookie|access_token|refresh_token)\s*[:=]\s*[A-Za-z0-9._~+\/-]{12,}/gi },
  { kind: 'seed_phrase', pattern: /\bseed\s+phrase\s*[:=]\s*(?:[a-z]+\s+){11,23}[a-z]+\b/gi },
];

const PERSONAL_PATTERNS: readonly { kind: ScanFinding['kind']; pattern: RegExp }[] = [
  { kind: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: 'phone', pattern: /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g },
  { kind: 'private_path', pattern: /(?:[A-Za-z]:\\Users\\[^\s\\]+\\[^\s]+|\/(?:home|Users)\/[^\s/]+\/[^\s]+)/g },
];

function luhn(value: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function scanDatasetText(text: string, includePersonalData = true): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  const collect = (kind: ScanFinding['kind'], severity: ScanFinding['severity'], pattern: RegExp) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      findings.push({ kind, severity, start: match.index, end: match.index + match[0].length });
    }
  };
  SECRET_PATTERNS.forEach(({ kind, pattern }) => collect(kind, 'secret', pattern));
  if (includePersonalData) PERSONAL_PATTERNS.forEach(({ kind, pattern }) => collect(kind, 'personal', pattern));
  if (includePersonalData) {
    const cards = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
    for (const match of text.matchAll(cards)) {
      const digits = match[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits) && match.index !== undefined) {
        findings.push({ kind: 'payment_card', severity: 'personal', start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return findings.sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((finding, index, all) => index === 0 || finding.start >= all[index - 1].end);
}

export function redactDatasetText(text: string, findings: readonly ScanFinding[]): string {
  return [...findings].sort((left, right) => right.start - left.start).reduce(
    (current, finding) => `${current.slice(0, finding.start)}[REDACTED_${finding.kind.toUpperCase()}]${current.slice(finding.end)}`,
    text,
  );
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable in this runtime.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function draftFromRecord(record: Record<string, unknown>, sourceKind: DatasetSourceKind, reference: string): DatasetDraft {
  const input = typeof record.input === 'string' ? record.input : typeof record.prompt === 'string' ? record.prompt : '';
  const expectedOutput = typeof record.expectedOutput === 'string' ? record.expectedOutput : typeof record.completion === 'string' ? record.completion : typeof record.output === 'string' ? record.output : '';
  const candidateType = typeof record.exampleType === 'string' ? record.exampleType : 'prompt_completion';
  const exampleType = candidateType as DatasetExampleType;
  return { input, expectedOutput, exampleType, sourceKind, sourceReference: reference, license: typeof record.license === 'string' ? record.license : 'user-owned', privacyClassification: 'private', tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [] };
}

/** Creates a transparent, deterministic local variation; it never calls a teacher or cloud model. */
export function buildLocalSyntheticVariation(draft: DatasetDraft): DatasetDraft {
  if (!draft.input.trim() || !draft.expectedOutput.trim()) throw new Error('Write and scan a seed input and approved target before staging a synthetic variation.');
  return {
    ...draft,
    input: `Apply the same constraints to this variation: ${draft.input.trim()}`,
    sourceKind: 'licensed',
    sourceReference: 'local-synthetic-template-v1',
    tags: [...new Set([...draft.tags, 'synthetic', 'local-template'])],
    synthetic: true,
    syntheticProvenance: 'local-synthetic-template-v1; deterministic prompt wrapper; no teacher model or network used',
  };
}

export function parseScopedDatasetImport(format: DatasetImportFormat, content: string, reference: string, mapping?: CsvMapping): readonly DatasetDraft[] {
  if (new TextEncoder().encode(content).byteLength > 5 * 1024 * 1024) throw new Error('Dataset import exceeds the 5 MB review limit.');
  let drafts: DatasetDraft[];
  if (format === 'jsonl') {
    drafts = content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`JSONL row ${index + 1} is not an object.`);
      return draftFromRecord(parsed as Record<string, unknown>, 'jsonl', `${reference}#${index + 1}`);
    });
  } else if (format === 'json') {
    const parsed = JSON.parse(content) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    drafts = records.map((record, index) => {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error(`JSON item ${index + 1} is not an object.`);
      return draftFromRecord(record as Record<string, unknown>, 'json', `${reference}#${index + 1}`);
    });
  } else if (format === 'csv') {
    if (!mapping) throw new Error('CSV import requires an explicit column mapping.');
    const [headers, ...rows] = parseCsvRows(content);
    if (!headers) return [];
    const inputIndex = headers.indexOf(mapping.inputColumn);
    const outputIndex = headers.indexOf(mapping.outputColumn);
    const typeIndex = mapping.typeColumn ? headers.indexOf(mapping.typeColumn) : -1;
    if (inputIndex < 0 || outputIndex < 0) throw new Error('CSV mapping references a missing column.');
    drafts = rows.map((row, index) => draftFromRecord({ input: row[inputIndex] ?? '', expectedOutput: row[outputIndex] ?? '', exampleType: typeIndex >= 0 ? row[typeIndex] : 'prompt_completion' }, 'csv', `${reference}#${index + 2}`));
  } else {
    drafts = [{ input: content, expectedOutput: 'Review required before assigning a target.', exampleType: 'prompt_completion', sourceKind: 'markdown', sourceReference: reference, license: 'user-owned', privacyClassification: 'private', tags: ['markdown-import'] }];
  }
  if (drafts.length > 1_000) throw new Error('Dataset import exceeds the 1,000-example review limit.');
  return drafts;
}

export async function buildDatasetVersion(drafts: readonly DatasetDraft[], options: DatasetBuildOptions): Promise<DatasetBuildResult> {
  if (!options.consentApproved) throw new Error('Explicit dataset consent is required.');
  if (!drafts.length) throw new Error('At least one dataset example is required.');
  const quarantined: { draftIndex: number; findingKinds: string[] }[] = [];
  const normalizedGroups = new Map<string, number[]>();
  const prepared = await Promise.all(drafts.map(async (draft, draftIndex) => {
    const combined = `${draft.input}\n${draft.expectedOutput}`;
    const findings = scanDatasetText(combined);
    if (findings.length) quarantined.push({ draftIndex, findingKinds: [...new Set(findings.map(({ kind }) => kind))] });
    const normalizedHash = await sha256(`${normalize(draft.input)}\n${normalize(draft.expectedOutput)}`);
    normalizedGroups.set(normalizedHash, [...(normalizedGroups.get(normalizedHash) ?? []), draftIndex]);
    return { draft, draftIndex, findings, normalizedHash, contentHash: await sha256(combined) };
  }));
  const duplicateGroups = [...normalizedGroups.entries()].filter(([, indexes]) => indexes.length > 1).map(([normalizedHash, draftIndexes]) => ({ normalizedHash, draftIndexes }));
  const duplicateIndexes = new Set(duplicateGroups.flatMap(({ draftIndexes }) => draftIndexes.slice(1)));
  const eligible = prepared.filter(({ draftIndex, draft, findings }) => !findings.length && !duplicateIndexes.has(draftIndex) && draft.input.trim() && draft.expectedOutput.trim() && draft.sourceReference.trim() && draft.license.trim());
  if (!eligible.length) throw new Error('No clean, unique, approved examples remain after review.');
  const datasetVersionId = `${options.datasetId}-v${options.version}`;
  const examples: DatasetExample[] = eligible.map(({ draft, draftIndex, contentHash }) => {
    const bucket = Number.parseInt(contentHash.slice(0, 8), 16) ^ options.seed;
    const split: DatasetExample['split'] = eligible.length < 10 ? 'train' : Math.abs(bucket % 100) < 80 ? 'train' : Math.abs(bucket % 100) < 90 ? 'validation' : 'test';
    return {
      id: `example-${contentHash.slice(0, 16)}`, projectId: options.projectId, datasetVersionId,
      exampleType: draft.exampleType, input: draft.input, expectedOutput: draft.expectedOutput, split,
      labels: [], tags: [...draft.tags], contentHash, provenance: { sourceId: `source-${contentHash.slice(0, 16)}`, sourceVersion: '1' },
      authorType: draft.synthetic ? 'synthetic_generator' : 'user', synthetic: draft.synthetic === true, license: draft.license, privacyClassification: draft.privacyClassification,
      qualityStatus: 'approved', approvalStatus: 'approved', secretScanStatus: 'passed', duplicateGroupId: null,
      tokenEstimate: Math.ceil((draft.input.length + draft.expectedOutput.length) / 4), testEvidence: null,
      reviewerId: options.actorId, rejectionReason: null,
      source: { kind: draft.sourceKind, reference: draft.syntheticProvenance ?? draft.sourceReference, approved: true },
      consent: { approved: true, actorId: options.actorId, approvedAt: options.now, purpose: options.consentPurpose },
      createdAt: options.now,
    };
  });
  const fingerprint = await sha256(examples.map(({ contentHash }) => contentHash).sort().join(':'));
  const manifestHash = await sha256(JSON.stringify({ datasetVersionId, fingerprint, seed: options.seed, included: examples.map(({ id }) => id) }));
  const statistics = { train: examples.filter(({ split }) => split === 'train').length, validation: examples.filter(({ split }) => split === 'validation').length, test: examples.filter(({ split }) => split === 'test').length };
  const manifest: DatasetVersionManifest = {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION, id: datasetVersionId, datasetId: options.datasetId,
    version: options.version, manifestHash, fingerprint, parentVersionId: options.parentVersionId,
    includedExampleIds: examples.map(({ id }) => id),
    excludedExampleIds: prepared.filter(({ draftIndex }) => duplicateIndexes.has(draftIndex)).map(({ contentHash, draftIndex }) => `excluded-${draftIndex}-${contentHash.slice(0, 12)}`),
    splitStrategy: { method: 'deterministic_hash', seed: options.seed, statistics }, examples,
    scanSummary: { status: 'passed', scanner: 'vibespace-static-v1', issueCount: 0 },
    qualitySummary: { status: 'passed', score: 1, reviewedBy: options.actorId },
    licenseReport: { status: 'passed', licenses: [...new Set(examples.map(({ license }) => license))], issueCount: 0 },
    secretScanReport: { status: 'passed', scanner: 'vibespace-static-v1', issueCount: 0 },
    lineage: { parentVersionId: options.parentVersionId, sourceDatasetIds: options.parentVersionId ? [options.parentVersionId] : [], feedbackEventIds: [] },
    createdAt: options.now,
  };
  const validation = validateDatasetVersion(manifest);
  if (!validation.valid) throw new Error(`Dataset manifest failed validation: ${validation.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return { manifest: Object.freeze(manifest), quarantined, duplicateGroups };
}
