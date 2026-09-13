import { applySecretPolicy } from '../security/secretDetector';
import type { PublicJson, PublicToolDetails, PublicToolFileChange, PublicToolOutput } from './adapters/types';

export const MAX_PUBLIC_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_DETAIL_BYTES = 128 * 1024;
const MAX_CHANGES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const SECRET_KEY = /(?:api[-_]?key|secret|password|passwd|passphrase|private[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|^token$)$/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Counts UTF-8 without allocating an encoded copy of an arbitrarily large result. */
function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function prefix(text: string, limit: number): { text: string; bytes: number } {
  const target = new Uint8Array(Math.max(0, limit));
  const { written = 0 } = encoder.encodeInto(text, target);
  return { text: decoder.decode(target.subarray(0, written)), bytes: written };
}

export function publicToolOutput(
  value: string, mode: 'append' | 'replace' = 'replace', complete = true,
  limit = MAX_PUBLIC_TOOL_OUTPUT_BYTES,
): Readonly<PublicToolOutput> {
  const bounded = prefix(value, Math.min(Math.max(0, limit), MAX_PUBLIC_TOOL_OUTPUT_BYTES));
  const cleaned = bounded.text.replace(ANSI, '').replace(CONTROLS, '');
  const safe = applySecretPolicy(cleaned, 'redact');
  const display = prefix(safe.text ?? '', Math.min(Math.max(0, limit), MAX_PUBLIC_TOOL_OUTPUT_BYTES));
  const omittedBytes = Math.max(0, byteLength(value) - bounded.bytes);
  const displayOmitted = byteLength(safe.text ?? '') > display.bytes;
  return Object.freeze({ text: display.text, mode, complete: complete && omittedBytes === 0 && !displayOmitted,
    omittedBytes: omittedBytes + Math.max(0, byteLength(safe.text ?? '') - display.bytes),
    ...(safe.decision === 'redacted' ? { redacted: true } : {}) });
}

/** A single bounded public boundary shared by native tool adapters. */
export function publicToolDetails(value: Readonly<Record<string, unknown>>): Readonly<PublicToolDetails> {
  let remaining = MAX_DETAIL_BYTES;
  let nodes = 0;
  let redacted = false;
  let truncated = false;
  const seen = new WeakSet<object>();
  const text = (value: string, limit = MAX_PUBLIC_TOOL_OUTPUT_BYTES): string => {
    const result = publicToolOutput(value, 'replace', true, Math.min(limit, remaining));
    remaining = Math.max(0, remaining - byteLength(result.text));
    redacted ||= result.redacted === true;
    truncated ||= !result.complete;
    return result.text;
  };
  const json = (value: unknown, depth = 0): PublicJson => {
    if (++nodes > 512 || depth > 8 || remaining <= 0) { truncated = true; return '[omitted: detail limit]'; }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object' || !value) return '[unavailable]';
    if (seen.has(value)) { truncated = true; return '[omitted: circular value]'; }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const result = value.slice(0, 128).map(item => json(item, depth + 1));
        if (value.length > 128) { truncated = true; result.push('[omitted: additional items]'); }
        return Object.freeze(result);
      }
      const result: Record<string, PublicJson> = Object.create(null);
      const keys = Object.keys(value);
      for (const key of keys.slice(0, 128)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const name = text(key, 256);
        if (SECRET_KEY.test(key)) { redacted = true; result[name] = '[redacted: credentials]'; }
        else result[name] = json((value as Record<string, unknown>)[key], depth + 1);
      }
      if (keys.length > 128) { truncated = true; result['[omitted]'] = 'Additional fields'; }
      return Object.freeze(result);
    } finally { seen.delete(value); }
  };
  const result: PublicToolDetails = {};
  for (const key of ['arguments', 'result', 'error'] as const) {
    if (value[key] !== undefined) result[key] = json(value[key]);
  }
  for (const key of ['command', 'cwd'] as const) {
    if (typeof value[key] === 'string') result[key] = text(value[key], key === 'cwd' ? 4096 : 8192);
  }
  if (typeof value.output === 'string') {
    result.output = publicToolOutput(value.output, 'replace', value.outputComplete !== false, remaining);
    remaining = Math.max(0, remaining - byteLength(result.output.text));
    redacted ||= result.output.redacted === true;
    truncated ||= result.output.omittedBytes > 0;
  }
  if (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0)
    result.durationMs = value.durationMs;
  if (Array.isArray(value.changes)) {
    const changes: PublicToolFileChange[] = [];
    for (const raw of value.changes.slice(0, MAX_CHANGES)) {
      const change = record(raw);
      if (!change || typeof change.path !== 'string') { truncated = true; continue; }
      const kindRecord = record(change.kind);
      const rawKind = kindRecord?.type ?? change.kind;
      const destination = change.destinationPath ?? kindRecord?.movePath ?? kindRecord?.move_path;
      const kind: PublicToolFileChange['kind'] = typeof destination === 'string' ? 'move' :
        rawKind === 'add' || rawKind === 'update' || rawKind === 'delete' || rawKind === 'move' ? rawKind : 'unknown';
      const item: PublicToolFileChange = { path: text(change.path, 4096), kind, complete: false };
      if (typeof destination === 'string') item.destinationPath = text(destination, 4096);
      if (typeof change.diff === 'string') {
        const diff = publicToolOutput(change.diff, 'replace', true, remaining);
        item.diff = diff.text; item.complete = diff.complete;
        remaining = Math.max(0, remaining - byteLength(diff.text));
        redacted ||= diff.redacted === true;
        truncated ||= !diff.complete;
      }
      changes.push(Object.freeze(item));
    }
    result.changes = Object.freeze(changes);
    if (value.changes.length > changes.length) {
      result.omittedChanges = value.changes.length - changes.length;
      truncated = true;
    }
  }
  if (redacted) result.redacted = true;
  if (truncated) result.truncated = true;
  return Object.freeze(result);
}

/** Absent fields never erase known details; terminal snapshots replace streamed output. */
export function mergePublicToolDetails(
  previous: Readonly<PublicToolDetails> | undefined,
  next: Readonly<PublicToolDetails>,
): Readonly<PublicToolDetails> {
  const result: PublicToolDetails = { ...previous, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) };
  if (next.output?.mode === 'append' && previous?.output) {
    const prior = previous.output;
    if (prior.complete) result.output = prior;
    else {
      const joined = publicToolOutput(prior.text + next.output.text, 'replace', next.output.complete);
      result.output = Object.freeze({ ...joined,
        omittedBytes: prior.omittedBytes + next.output.omittedBytes + joined.omittedBytes,
        complete: joined.complete && prior.omittedBytes === 0 && next.output.omittedBytes === 0,
        ...(prior.redacted || next.output.redacted ? { redacted: true } : {}) });
    }
  }
  if (previous?.redacted || next.redacted || result.output?.redacted) result.redacted = true;
  if (previous?.truncated || next.truncated) result.truncated = true;
  return Object.freeze(result);
}


/** Both live SSE and persisted recovery use the same public OpenCode projection. */
export function openCodeToolDetails(tool: string, value: unknown): Readonly<PublicToolDetails> {
  const state = record(value);
  const input = record(state?.input);
  const metadata = record(state?.metadata);
  let displayInput: unknown = state?.input;
  let displayOutput: unknown = state?.output;
  let internalFieldsOmitted = false;
  if ((tool === 'todowrite' || tool === 'todoread') && input) {
    displayInput = { todos: Array.isArray(input.todos) ? input.todos.slice(0, 128).map(value => {
      const todo = record(value);
      return todo ? Object.fromEntries(['id', 'content', 'status', 'priority'].filter(key => todo[key] !== undefined).map(key => [key, todo[key]])) : null;
    }) : [] };
    internalFieldsOmitted = true;
  }
  if (tool === 'task' && input && ('prompt' in input || 'systemPrompt' in input || 'developerInstructions' in input)) {
    const { prompt: _prompt, systemPrompt: _system, developerInstructions: _developer, ...publicInput } = input;
    displayInput = publicInput;
    internalFieldsOmitted = true;
  }
  if (tool === 'vibespace_context' && typeof displayOutput === 'string') {
    if (displayOutput.length <= 1024 * 1024) {
      try {
        const envelope = record(JSON.parse(displayOutput));
        if (envelope) {
          const { requestId: _request, ...publicEnvelope } = envelope;
          const data = record(publicEnvelope.data);
          if (data) {
            const { receiptId: _receipt, scopeRevision: _scope, ...publicData } = data;
            publicEnvelope.data = publicData;
            internalFieldsOmitted ||= 'receiptId' in data || 'scopeRevision' in data;
          }
          internalFieldsOmitted ||= 'requestId' in envelope;
          displayOutput = JSON.stringify(publicEnvelope);
        }
      } catch { /* Plain tool errors still cross the normal public-text boundary. */ }
    } else {
      return Object.freeze({ ...publicToolDetails({ arguments: displayInput }), truncated: true, redacted: true,
        output: Object.freeze({ text: 'Context result exceeds the safe inline preview limit.', mode: 'replace' as const,
          complete: false, omittedBytes: byteLength(displayOutput) }) });
    }
  }
  const filePath = input?.path ?? input?.filePath ?? input?.file_path ?? input?.filepath;
  const isEdit = /^(edit|write|apply_patch)$/.test(tool);
  const changes = isEdit && Array.isArray(metadata?.files)
    ? metadata.files.map(raw => { const file = record(raw); return {
        path: file?.path ?? file?.filePath, kind: file?.type ?? 'unknown', diff: file?.diff,
      }; })
    : isEdit && typeof filePath === 'string'
      ? [{ path: filePath, kind: tool === 'edit' ? 'update' : 'unknown', diff: metadata?.diff }]
      : undefined;
  const details = publicToolDetails({ arguments: displayInput, command: input?.command ?? input?.cmd,
    cwd: input?.workdir ?? input?.cwd, output: displayOutput,
    outputComplete: state?.status === 'completed' || state?.status === 'error',
    error: state?.error, exitCode: metadata?.exit ?? metadata?.exitCode ?? metadata?.exit_code,
    durationMs: metadata?.durationMs, changes });
  return internalFieldsOmitted ? Object.freeze({ ...details, redacted: true }) : details;
}
