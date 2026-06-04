/**
 * AI context helpers — pull together the runtime-time prompt
 * supplements that aren't part of the agent's own system prompt:
 *
 *   1. Active project's `system_prompt_context` blob, gated by the
 *      project's `no_context_mode` flag. This is the "every agent
 *      should know about my repo conventions" knob.
 *
 *   2. Files explicitly pinned to terminal panes whose `agentSlug`
 *      matches the agent we're about to call. The user attaches a
 *      file to a Coder pane → the Coder agent sees that file's
 *      content on every request, without copy-pasting.
 *
 * Both helpers return the empty string when there's nothing to add,
 * so the runtime can simply concat them with `\n\n` and skip the
 * splice when nothing's there.
 *
 * Why this lives in a separate file:
 *   - `runtime.ts` is already long and braces a big async flow.
 *     Helpers that involve DB access + fs reads + tree walks are
 *     better isolated so they can be unit-tested without spinning up
 *     the whole event loop.
 *   - The pane-tree walk relies on the localStorage shape produced
 *     by `TerminalsPage`. Keeping that knowledge in one file means a
 *     future tree refactor only has to update one consumer.
 */

import { projectRepo } from '@/lib/db';
import type { ProjectId } from '@/types';
import { readTextFileSample, type FsReadResult } from '@/lib/fs';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { parseTerminalRef, terminalRefLabel, type TerminalRef } from '@/features/terminals/terminalRefs';
import {
  formatContextAttachmentForPrompt,
  formatContextTreeForPrompt,
  loadStoredContextTree,
  type ContextAttachment,
} from '@/features/context/tree';

/**
 * Cap on the total bytes of file content we splice into a single AI
 * request. Native file reads allow files up to 100 MiB, and prompt
 * but multiple connected files would still blow past every model's
 * context budget. 16 KiB is a safe ceiling — about 4k tokens — that
 * leaves room for the user's actual question and the rest of
 * history.
 */
const TOTAL_FILE_BUDGET_BYTES = 16 * 1024;
const FILE_SAMPLE_READ_BYTES = 64 * 1024;
const MEDIA_CONTEXT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
]);

/**
 * Read the active project and produce its system-prompt context
 * block. Returns the empty string when:
 *   - no project is active,
 *   - the project's `system_prompt_context` is empty / whitespace,
 *   - or the project has `no_context_mode === true`.
 *
 * The block is fenced as data so a hostile context blob can't
 * hijack the conversation with embedded "ignore previous
 * instructions" prose.
 */
export async function getProjectContextBlock(
  projectId: ProjectId | null,
): Promise<string> {
  if (!projectId) return '';
  let project;
  try {
    project = await projectRepo.getById(projectId);
  } catch {
    // DB errors here are non-fatal — we just skip the context splice.
    return '';
  }
  if (!project) return '';
  if (project.no_context_mode) return '';
  const blob = (project.system_prompt_context ?? '').trim();
  if (blob.length === 0) return '';

  return [
    `You are working inside the user's "${project.name}" project. Treat the block below as durable, project-level context — every request from this project carries it. Do not echo it verbatim unless asked.`,
    '',
    '--- project_context ---',
    '```',
    blob,
    '```',
  ].join('\n');
}

export function getProjectContextTreeBlock(projectId: ProjectId | null): string {
  const tree = loadStoredContextTree(projectId);
  if (!tree) return '';
  return formatContextTreeForPrompt(tree);
}

/**
 * Same storage-key helper as `TerminalsPage` — the prefix is shared
 * because both modules need to agree on the slot name. If you change
 * one, change the other.
 */
function treeStorageKey(projectId: string | null): string {
  return `jarvis-terminal-pane-tree:${projectId ?? '__default__'}`;
}

interface LeafLike {
  kind: 'leaf';
  agentSlug?: string;
  connectedFiles?: string[];
}

interface SplitLike {
  kind: 'split';
  left: LeafLike | SplitLike;
  right: LeafLike | SplitLike;
}

type NodeLike = LeafLike | SplitLike;

/**
 * Walk the persisted pane tree for `projectId` and return every
 * connected-file path attached to a leaf whose `agentSlug` matches.
 * The returned list is de-duplicated and order-preserving (first
 * occurrence wins), which keeps the prompt deterministic across
 * reloads.
 *
 * Failures (no localStorage, malformed JSON, missing key) all yield
 * an empty list — connected files are an enhancement, not a hard
 * dependency.
 */
function collectConnectedFilePaths(
  agentSlug: string,
  projectId: string | null,
): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const key = treeStorageKey(projectId);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as NodeLike;
    if (n.kind === 'leaf') {
      if (
        n.agentSlug === agentSlug &&
        Array.isArray(n.connectedFiles)
      ) {
        for (const p of n.connectedFiles) {
          if (typeof p === 'string' && !seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
      }
      return;
    }
    if (n.kind === 'split') {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(parsed);
  return out;
}

/**
 * For an agent slug, find every file the user pinned to a terminal
 * pane bound to that agent (in the active project), read them, and
 * format the content as a fenced multi-file context block.
 *
 * Files that fail to read (missing, too large, not UTF-8, …) are
 * surfaced as one-line entries instead of being silently dropped —
 * the agent should know "I tried to look at X but it's gone" rather
 * than reasoning over phantom data.
 *
 * Returns the empty string when nothing was pinned or no projectId
 * is active.
 */
export async function getConnectedFilesBlock(
  agentSlug: string,
  projectId: string | null,
): Promise<string> {
  if (!agentSlug) return '';
  const paths = collectConnectedFilePaths(agentSlug, projectId);
  if (paths.length === 0) return '';

  const results = await readPromptFileSamples(paths);

  let used = 0;
  const blocks: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      blocks.push(
        `--- ${r.path} ---\n[error: could not read — ${r.error.code}]`,
      );
      continue;
    }
    // Trim each file to whatever's left of the budget. Truncations
    // are flagged inline so the model can ask for more if needed.
    const remaining = TOTAL_FILE_BUDGET_BYTES - used;
    if (remaining <= 0) {
      blocks.push(`--- ${r.path} ---\n[skipped: prompt budget exhausted]`);
      continue;
    }
    const content = r.content;
    let chunk = content;
    let truncated = false;
    if (chunk.length > remaining) {
      chunk = chunk.slice(0, remaining);
      truncated = true;
    }
    used += chunk.length;
    blocks.push(
      `--- ${r.path}${truncated ? ' (truncated)' : ''} ---\n\`\`\`\n${chunk}\n\`\`\``,
    );
  }

  if (blocks.length === 0) return '';

  const intro = [
    `The user has pinned ${results.length === 1 ? 'a file' : `${results.length} files`} to a terminal pane bound to @${agentSlug}.`,
    'Treat the contents below as up-to-date project context. Do not assume any other file you remember is current — ask if you need more.',
  ].join(' ');

  return `${intro}\n\n${blocks.join('\n\n')}`;
}

export async function getExplicitFilesBlock(paths: string[]): Promise<string> {
  const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean))).slice(0, 8);
  if (unique.length === 0) return '';
  const results = await readPromptFileSamples(unique);
  let used = 0;
  const blocks: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      blocks.push(`--- ${r.path} ---\n[error: could not read — ${r.error.code}]`);
      continue;
    }
    const remaining = TOTAL_FILE_BUDGET_BYTES - used;
    if (remaining <= 0) {
      blocks.push(`--- ${r.path} ---\n[skipped: prompt budget exhausted]`);
      continue;
    }
    let chunk = r.content;
    let truncated = false;
    if (chunk.length > remaining) {
      chunk = chunk.slice(0, remaining);
      truncated = true;
    }
    used += chunk.length;
    blocks.push(`--- ${r.path}${truncated ? ' (truncated)' : ''} ---\n\`\`\`\n${chunk}\n\`\`\``);
  }
  return [
    `The user attached ${unique.length === 1 ? 'this file' : `${unique.length} files`} to the current chat message. Treat this as request-specific context and prefer it over stale memory.`,
    '',
    ...blocks,
  ].join('\n');
}

async function readPromptFileSamples(paths: string[]): Promise<FsReadResult[]> {
  const settled = await Promise.allSettled(paths.map(async (path): Promise<FsReadResult> => {
    if (isMediaPromptFile(path)) {
      return { ok: true, path, content: mediaPromptMetadata(path) };
    }
    return readTextFileSample(path, FILE_SAMPLE_READ_BYTES);
  }));
  return settled.map((result, index) => {
    const path = paths[index] ?? '';
    if (result.status === 'fulfilled') return result.value;
    return {
      ok: false,
      error: { code: 'unknown', raw: String(result.reason) },
      path,
    };
  });
}

function isMediaPromptFile(path: string): boolean {
  return MEDIA_CONTEXT_EXTENSIONS.has(fileExtension(path));
}

function mediaPromptMetadata(path: string): string {
  const ext = fileExtension(path);
  const kind = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)
    ? 'video'
    : ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)
      ? 'audio'
      : 'image';
  return [
    `Media file metadata only (${kind}).`,
    `Path: ${path}`,
    `Extension: ${ext || 'unknown'}`,
    'Binary bytes were not read into the prompt.',
  ].join('\n');
}

function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function getExplicitContextBlock(contexts: ContextAttachment[]): string {
  const unique = contexts
    .filter((context) => context && context.nodeId && context.summary)
    .filter((context, index, arr) => arr.findIndex((item) => item.nodeId === context.nodeId) === index)
    .slice(0, 8);
  if (unique.length === 0) return '';
  return [
    `The user attached ${unique.length === 1 ? 'this Context node' : `${unique.length} Context nodes`} to the current message. Treat it as request-specific project context and use it before broad assumptions.`,
    '',
    ...unique.map(formatContextAttachmentForPrompt),
  ].join('\n');
}

export function getExplicitTerminalBlock(refs: Array<string | TerminalRef>): string {
  const parsed = refs
    .map((ref) => (typeof ref === 'string' ? parseTerminalRef(ref) : ref))
    .filter((ref): ref is TerminalRef => !!ref && (!!ref.sessionId || !!ref.paneId))
    .slice(0, 8);
  const seen = new Set<string>();
  const unique = parsed.filter((ref) => {
    const key = ref.paneId || ref.sessionId || terminalRefLabel(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return '';
  const sessions = useTerminalTranscriptStore.getState().sessions;
  const blocks = unique.map((ref) => {
    const id = ref.sessionId ?? ref.paneId ?? terminalRefLabel(ref);
    const s = ref.sessionId && sessions[ref.sessionId]
      ? sessions[ref.sessionId]
      : Object.values(sessions).find((session) => session.paneId && session.paneId === ref.paneId);
    if (!s) {
      return [
        `--- terminal:${id} (${terminalRefLabel(ref)}) ---`,
        `pane=${ref.paneId ?? 'unknown'} session=${ref.sessionId ?? 'not attached'} agent=${ref.agentSlug ?? 'unassigned'}`,
        '[transcript not found yet; the pane may need to be reopened so Jarvis can reattach or respawn it]',
      ].join('\n');
    }
    const ageSec = Math.max(0, Math.round((Date.now() - s.lastWriteAt) / 1000));
    return [
      `--- terminal:${id} ${s.command ? `(${s.command})` : `(${terminalRefLabel(ref)})`} ---`,
      `pane=${ref.paneId ?? 'unknown'} session=${s.sessionId}`,
      `agent=${s.agentSlug ?? 'unassigned'} last_write=${ageSec}s_ago bytes_seen=${s.bytesSeen}`,
      s.currentInput ? `current_input=${JSON.stringify(s.currentInput.slice(-300))}` : '',
      '```',
      s.text || '[no captured output yet]',
      '```',
    ].filter(Boolean).join('\n');
  });
  return [
    `The user attached ${unique.length === 1 ? 'a terminal' : `${unique.length} terminals`} to this message. Use these transcripts to answer questions about current CLI/AI progress.`,
    'Treat the transcript as evidence, not proof of completion. If the user asks whether an AI/task is done, only say yes when the visible output clearly shows completion, success, a final answer, or an idle prompt after the relevant work. If the output is still streaming, stale, missing, or ambiguous, say that explicitly and cite the last visible terminal lines.',
    '',
    ...blocks,
  ].join('\n');
}
