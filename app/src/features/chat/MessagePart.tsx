import { Bot, FileText, Image as ImageIcon, Layers, Zap } from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';
import { ActionApprovalCard } from './ActionApprovalCard';
import { StackTimeline } from './StackTimeline';
import { parseActionBlocks } from '@/lib/actions';
import type { Part } from '@/types';
import type { MessageId } from '@/types/common';
import {
  JARVIS_CREATOR_APPLY_AGENT_EVENT,
  JARVIS_CREATOR_APPLY_SKILL_EVENT,
  parseLooseJarvisCreatorAgentDraft,
  parseLooseJarvisCreatorSkillDraft,
  parseJarvisCreatorDraft,
  normalizeJarvisCreatorSkillDraft,
  type JarvisCreatorKind,
} from '@/features/jarvis-creator/contracts';
import { QuestionBlockCard } from '@/features/jarvis-interaction/QuestionBlockCard';
import { PlanReviewCard } from '@/features/jarvis-interaction/PlanReviewCard';
import { PermissionRequestCard } from '@/features/jarvis-interaction/PermissionRequestCard';
import { AgentActivityCard } from '@/features/jarvis-interaction/AgentActivityCard';
import {
  activeChatCommandLabel,
  parseActiveChatCommandMessage,
} from './chatActiveCommands';
import { cn } from '@/lib/utils';
import { UsageCard } from './UsageCard';
import { ContextInspectorCard } from './ContextInspectorCard';
import { TokenOptimizationReceiptView } from '@/features/token-optimizer';

function textForDisplay(text: string): string {
  if (!text.includes('```')) return text;
  const parsed = parseActionBlocks(text);
  if (!parsed.hasActionBlocks) return text;
  const prose = parsed.segments
    .filter((seg): seg is Extract<typeof seg, { kind: 'prose' }> => seg.kind === 'prose')
    .map((seg) => seg.text)
    .join('')
    .trim();
  return prose;
}

const RENDERABLE_REFERENCE_PROTOCOLS = new Set([
  'https:',
  'asset:',
  'vibespace:',
  'app:',
  'jarvis:',
  'tauri:',
]);

function renderableReferenceUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    return RENDERABLE_REFERENCE_PROTOCOLS.has(new URL(uri).protocol) ? uri : undefined;
  } catch {
    return undefined;
  }
}

/** Distinct “command in use” card — not an attachment chip. */
function ActiveChatCommandMessage({ text }: { text: string }) {
  const parsed = parseActiveChatCommandMessage(text);
  if (!parsed) return null;
  const isSub = parsed.cmd === 'subagents';
  const Icon = isSub ? Layers : Bot;
  return (
    <div
      data-testid="active-chat-command"
      data-command={parsed.cmd}
      className={cn(
        'relative overflow-hidden rounded-xl border px-3 py-2.5',
        'shadow-[0_0_22px_rgba(0,0,0,0.18)]',
        isSub
          ? 'border-fuchsia-400/50 bg-gradient-to-br from-fuchsia-500/18 via-violet-500/12 to-background/40'
          : 'border-cyan-400/50 bg-gradient-to-br from-cyan-500/18 via-sky-500/12 to-background/40',
      )}
      title={`${activeChatCommandLabel(parsed.cmd)} command in use`}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-1',
          isSub ? 'bg-fuchsia-400' : 'bg-cyan-400',
        )}
      />
      <div className="flex flex-wrap items-center gap-2 pl-1.5">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide',
            isSub
              ? 'border-fuchsia-400/55 bg-fuchsia-500/20 text-fuchsia-100'
              : 'border-cyan-400/55 bg-cyan-500/20 text-cyan-100',
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          /{parsed.cmd}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wider',
            isSub
              ? 'bg-fuchsia-400/25 text-fuchsia-100 ring-1 ring-fuchsia-300/40'
              : 'bg-cyan-400/25 text-cyan-100 ring-1 ring-cyan-300/40',
          )}
        >
          <Zap className="h-2.5 w-2.5" />
          In use
        </span>
      </div>
      {parsed.task ? (
        <p className="mt-2 pl-1.5 text-body text-foreground/95 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">
          {parsed.task}
        </p>
      ) : null}
    </div>
  );
}

function CreatorDraftApply({ text, kind }: { text: string; kind?: JarvisCreatorKind }) {
  if (!kind) return null;

  if (kind === 'agent') {
    const agent = parseJarvisCreatorDraft('agent', text);
    if (agent.ok) {
      return (
        <button
          type="button"
          className="mt-2 w-fit rounded-md border border-accent-copper/45 bg-accent-copper/10 px-2 py-1 text-metadata text-foreground hover:border-accent-copper/70"
          onClick={() => window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_AGENT_EVENT, { detail: agent.draft }))}
        >
          Push to agent
        </button>
      );
    }
    const looseAgent = parseLooseJarvisCreatorAgentDraft(text);
    if (looseAgent.ok) {
      return (
        <button
          type="button"
          className="mt-2 w-fit rounded-md border border-accent-copper/45 bg-accent-copper/10 px-2 py-1 text-metadata text-foreground hover:border-accent-copper/70"
          onClick={() => window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_AGENT_EVENT, { detail: looseAgent.draft }))}
        >
          Push to agent
        </button>
      );
    }
    return null;
  }

  const skill = parseJarvisCreatorDraft('skill', text);
  if (skill.ok) {
    const normalized = normalizeJarvisCreatorSkillDraft(skill.draft);
    if (normalized) {
      return (
        <button
          type="button"
          className="mt-2 w-fit rounded-md border border-accent-copper/45 bg-accent-copper/10 px-2 py-1 text-metadata text-foreground hover:border-accent-copper/70"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(JARVIS_CREATOR_APPLY_SKILL_EVENT, { detail: normalized }),
            )
          }
        >
          Push to skill
        </button>
      );
    }
  }
  const looseSkill = parseLooseJarvisCreatorSkillDraft(text);
  if (looseSkill.ok) {
    const normalized = normalizeJarvisCreatorSkillDraft(looseSkill.draft);
    if (normalized) {
      return (
        <button
          type="button"
          className="mt-2 w-fit rounded-md border border-accent-copper/45 bg-accent-copper/10 px-2 py-1 text-metadata text-foreground hover:border-accent-copper/70"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(JARVIS_CREATOR_APPLY_SKILL_EVENT, { detail: normalized }),
            )
          }
        >
          Push to skill
        </button>
      );
    }
  }
  return null;
}

export interface MessagePartProps {
  part: Part;
  /**
   * Full parts array of the parent message - lets us pair a `tool_call`
   * with its matching `tool_result` for inline rendering.
   */
  allParts: Part[];
  /**
   * Parent message id. Required for parts whose UI needs to write back
   * to the message (e.g. an `action_proposal` flipping its status when
   * the user clicks Approve). Optional so existing renderers without
   * this context still type-check.
   */
  messageId?: MessageId;
  /** Parent chat id. Same rationale as `messageId`. */
  chatId?: string;
  /** When true, prose renders with the flowing warm Hive gradient. */
  hiveWords?: boolean;
  /** Keep user-pasted media compact while retaining an on-demand preview. */
  compactAttachments?: boolean;
  /** Enables Make-with-Jarvis apply/push controls for the matching creator thread only. */
  creatorDraftKind?: JarvisCreatorKind;
}

/**
 * Dispatch on Part.kind. Each part renders as its own block in the bubble body.
 * Pairs tool_call <-> tool_result by call_id.
 */
export function MessagePart({
  part,
  allParts,
  messageId,
  chatId,
  hiveWords,
  compactAttachments,
  creatorDraftKind,
}: MessagePartProps) {
  switch (part.kind) {
    case 'text': {
      if (!part.text) {
        return <span className="inline-block h-3 w-3 rounded-full bg-muted-foreground/40 animate-pulse" aria-label="Thinking" />;
      }
      const activeCommand = parseActiveChatCommandMessage(part.text);
      if (activeCommand) {
        return <ActiveChatCommandMessage text={part.text} />;
      }
      const display = textForDisplay(part.text);
      if (!display && part.text.includes('```action')) {
        return (
          <p className="text-secondary italic text-muted-foreground">
            Jarvis is preparing an action for your approval…
          </p>
        );
      }
      return (
        <div className="flex flex-col">
          <div
            className={
              hiveWords
                ? 'hive-words text-body font-medium whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed'
                : 'text-body text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed'
            }
          >
            {display || part.text}
          </div>
          <CreatorDraftApply text={part.text} kind={creatorDraftKind} />
        </div>
      );
    }

    case 'reasoning': {
      if (!part.text) return null;
      return (
        <div className="text-secondary text-muted-foreground italic whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 border-border pl-2">
          {part.text}
        </div>
      );
    }

    case 'usage_card': {
      return <UsageCard snapshots={part.snapshots} scope={part.scope} />;
    }

    case 'token_optimization_receipt': {
      return <TokenOptimizationReceiptView receipt={part.receipt} usage={part.usage} />;
    }

    case 'context_inspector': {
      return <ContextInspectorCard inspector={part.inspector} />;
    }

    case 'stack_step': {
      const steps = allParts.filter(
        (p): p is Extract<Part, { kind: 'stack_step' }> => p.kind === 'stack_step',
      );
      if (steps[0] !== part) return null;
      return <StackTimeline steps={steps} />;
    }

    case 'tool_call': {
      const result = allParts.find(
        (p): p is Extract<Part, { kind: 'tool_result' }> =>
          p.kind === 'tool_result' && p.call_id === part.call_id,
      );
      return <ToolCallCard call={part} result={result} />;
    }

    case 'tool_result': {
      // Tool results are rendered alongside their tool_call. Skip if a
      // matching call exists; otherwise show as an orphan card.
      const hasCall = allParts.some(
        (p) => p.kind === 'tool_call' && p.call_id === part.call_id,
      );
      if (hasCall) return null;
      return (
        <div className="rounded-md border border-border bg-elevated px-3 py-2">
          <div className="text-metadata text-muted-foreground mb-1 uppercase tracking-wide">
            Tool result ({part.call_id})
          </div>
          <pre className="text-metadata font-mono whitespace-pre-wrap break-words">
            {part.error ?? JSON.stringify(part.result, null, 2)}
          </pre>
        </div>
      );
    }

    case 'action_proposal': {
      // Without messageId/chatId we can't mutate the proposal's status,
      // so degrade to a read-only line. Practically every assistant
      // bubble passes both, but the optional contract keeps any
      // future renderer (e.g. preview / replay) honest.
      if (!messageId || !chatId) {
        return (
          <div className="rounded-md border border-border bg-elevated px-3 py-2 text-secondary text-muted-foreground">
            Action proposal:{' '}
            <span className="font-mono text-foreground">{part.action_id}</span>{' '}
            <span className="text-metadata uppercase">({part.status})</span>
          </div>
        );
      }
      return (
        <ActionApprovalCard
          part={part}
          allParts={allParts}
          messageId={messageId}
          chatId={chatId}
        />
      );
    }

    case 'question_block': {
      return <QuestionBlockCard part={part} messageId={messageId} chatId={chatId} />;
    }

    case 'question_answer': {
      return (
        <div className="rounded-md border border-border bg-elevated px-3 py-2 text-secondary text-muted-foreground">
          Jarvis question answers saved.
        </div>
      );
    }

    case 'plan_review': {
      return <PlanReviewCard part={part} messageId={messageId} chatId={chatId} />;
    }

    case 'permission_request': {
      return <PermissionRequestCard part={part} messageId={messageId} chatId={chatId} />;
    }

    case 'agent_card': {
      return <AgentActivityCard part={part} />;
    }

    case 'image': {
      if (compactAttachments) {
        return (
          <details className="max-w-sm rounded-md border border-border bg-elevated">
            <summary className="cursor-pointer list-none px-2 py-1 text-secondary text-foreground">
              <span className="inline-flex items-center gap-1.5">
                <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                [Image{part.alt ? `: ${part.alt}` : ''}]
              </span>
            </summary>
            <img
              src={part.url}
              alt={part.alt ?? ''}
              className="block h-auto max-h-80 w-full object-contain"
              loading="lazy"
            />
          </details>
        );
      }
      return (
        <div className="rounded-md overflow-hidden border border-border bg-elevated max-w-sm">
          <img
            src={part.url}
            alt={part.alt ?? ''}
            className="block w-full h-auto"
            loading="lazy"
          />
          {part.alt && (
            <div className="px-2 py-1 text-metadata text-muted-foreground flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />
              {part.alt}
            </div>
          )}
        </div>
      );
    }

    case 'file_ref': {
      const ref = part.ref;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-secondary text-foreground">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-metadata">{ref.kind}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate max-w-[20ch]">{ref.id}</span>
          {ref.excerpt && (
            <span className="text-muted-foreground truncate max-w-[24ch]">"{ref.excerpt}"</span>
          )}
        </div>
      );
    }

    case 'jarvis_source_ref': {
      const source = part.source;
      const uri =
        source.sensitivity === 'restricted' || source.sensitivity === 'secret'
          ? undefined
          : renderableReferenceUri(source.uri);
      const label = (
        <>
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{source.label}</span>
        </>
      );
      return (
        <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-elevated px-2 py-1 text-secondary text-foreground">
          {uri ? (
            <a
              href={uri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline"
              aria-label={source.label}
            >
              {label}
            </a>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5">{label}</span>
          )}
          <span className="text-metadata uppercase text-muted-foreground">
            {source.sensitivity}
          </span>
        </div>
      );
    }

    case 'jarvis_artifact_ref': {
      const artifact = part.artifact;
      const uri = renderableReferenceUri(artifact.uri);
      const title = (
        <>
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{artifact.title}</span>
        </>
      );
      return (
        <div className="flex max-w-sm flex-col gap-1 rounded-md border border-border bg-elevated px-3 py-2 text-secondary text-foreground">
          <div className="flex items-center justify-between gap-2">
            {uri ? (
              <a
                href={uri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline"
                aria-label={artifact.title}
              >
                {title}
              </a>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5">{title}</span>
            )}
            <span className="text-metadata uppercase text-muted-foreground">{artifact.state}</span>
          </div>
          {artifact.safeSummary ? (
            <p className="text-metadata text-muted-foreground">{artifact.safeSummary}</p>
          ) : null}
        </div>
      );
    }

    default: {
      // Exhaustive check - new Part kinds will surface here at compile time.
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}
