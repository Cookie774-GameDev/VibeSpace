import { contextEvidenceNavigation, ContextEvidenceNavigationError, isContextEvidenceUri } from '@/features/context/contextEvidenceNavigation';
import { Bot, FileText, Image as ImageIcon, Layers, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingDisclosure } from './ThinkingDisclosure';
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
  type JarvisCreatorAgentDraft,
  type JarvisCreatorKind,
  type JarvisCreatorSkillDraft,
} from '@/features/jarvis-creator/contracts';
import { buildVibeSpaceSkillPackage } from '@/features/jarvis-creator/skillPackage';
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
import { PluginUsageCard, resolvePluginActionEvidence } from './PluginUsageCard';
import { presentProviderError } from '@/lib/ai/providerError';
import { AssistantRichText } from './AssistantRichText';
import { ToolFileLink } from './activity-ledger/ToolDetailsInspector';
import { resolveToolChatRoot } from './activity-ledger/toolFileActions';
import { chatRepo, messageRepo } from '@/lib/db/repositories';
import { MediaPreviewPanel, type MediaPreviewTarget } from './MediaPreviewPanel';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { toast } from '@/components/ui/toast';
import type { ChatId } from '@/types/common';

function TaskMessageSourceLink({
  sourceChatId,
  recipientChatId,
}: {
  sourceChatId: string;
  recipientChatId?: string;
}) {
  const openSource = async () => {
    const workspaceId = useAuthStore.getState().workspaceId;
    if (!workspaceId || !recipientChatId) return;
    try {
      const [source, recipient] = await Promise.all([
        chatRepo.getById(sourceChatId as ChatId),
        chatRepo.getById(recipientChatId as ChatId),
      ]);
      if (
        !source ||
        !recipient ||
        source.archived ||
        String(source.workspace_id) !== String(workspaceId) ||
        String(recipient.workspace_id) !== String(workspaceId) ||
        useAuthStore.getState().workspaceId !== workspaceId
      ) {
        toast.warning('Source chat unavailable', 'The task chat is no longer in this workspace.');
        return;
      }
      const ui = useUIStore.getState();
      ui.setActiveChat(source.id);
      ui.setChatMode(source.mode);
      ui.setRoute('chat');
    } catch {
      toast.warning('Source chat unavailable', 'Could not open the task chat. Please try again.');
    }
  };
  return (
    <button
      type="button"
      onClick={() => void openSource()}
      className="mt-1 text-metadata font-medium text-accent-copper underline-offset-2 hover:underline focus-visible:underline"
    >
      Sent by task
    </button>
  );
}

function ChatFileReference({ path, chatId }: { path: string; chatId?: string }) {
  const [projectRoot, setProjectRoot] = useState<string>();
  useEffect(() => {
    let current = true;
    setProjectRoot(undefined);
    if (chatId) {
      void resolveToolChatRoot(chatId)
        .then((root) => { if (current) setProjectRoot(root); })
        .catch(() => { if (current) setProjectRoot(undefined); });
    }
    return () => { current = false; };
  }, [chatId]);
  return <ToolFileLink path={path} projectRoot={projectRoot} />;
}

function MessageImagePart({
  part,
  allParts,
  messageId,
  compact,
}: {
  part: Extract<Part, { kind: 'image' }>;
  allParts: Part[];
  messageId?: MessageId;
  compact?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const target: MediaPreviewTarget = {
    kind: 'media',
    name: part.alt || 'Chat image',
    url: part.url,
    mediaKind: 'image',
  };

  const saveEditedCopy = useCallback(
    async (pngDataUrl: string) => {
      if (!messageId) throw new Error('This image is not attached to a saved chat message.');
      const saved = await messageRepo.getById(messageId);
      if (!saved) throw new Error('The chat message could not be found. Reopen the image and try again.');
      const matchesSource = (candidate: Part | undefined) =>
        candidate?.kind === 'image' && candidate.url === part.url && candidate.alt === part.alt;
      const preferredIndex = allParts.indexOf(part);
      let sourceIndex = matchesSource(saved.parts[preferredIndex]) ? preferredIndex : -1;
      if (sourceIndex < 0) sourceIndex = saved.parts.findIndex(matchesSource);
      if (sourceIndex < 0) {
        throw new Error('The original image changed while you were editing. Reopen it from chat.');
      }

      const editedCopy: Part = {
        kind: 'image',
        url: pngDataUrl,
        alt: `Edited copy${part.alt ? ` of ${part.alt}` : ''}`,
      };
      const parts = [...saved.parts];
      parts.splice(sourceIndex + 1, 0, editedCopy);
      await messageRepo.update(messageId, { parts });
    },
    [allParts, messageId, part],
  );

  const openButton = (image: ReactNode) => (
    <button
      type="button"
      className="block w-full cursor-zoom-in text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper"
      aria-label={`Open image editor for ${part.alt || 'image'}`}
      onClick={() => setPreviewOpen(true)}
    >
      {image}
    </button>
  );

  return (
    <>
      {compact ? (
        <details className="max-w-sm rounded-md border border-border bg-elevated">
          <summary className="cursor-pointer list-none px-2 py-1 text-secondary text-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
              [Image{part.alt ? `: ${part.alt}` : ''}]
            </span>
          </summary>
          {openButton(
            <img
              src={part.url}
              alt={part.alt ?? ''}
              className="block h-auto max-h-80 w-full object-contain"
              loading="lazy"
            />,
          )}
        </details>
      ) : (
        <div className="max-w-sm overflow-hidden rounded-md border border-border bg-elevated">
          {openButton(
            <img
              src={part.url}
              alt={part.alt ?? ''}
              className="block h-auto w-full"
              loading="lazy"
            />,
          )}
          {part.alt && (
            <div className="flex items-center gap-1 px-2 py-1 text-metadata text-muted-foreground">
              <ImageIcon className="h-3 w-3" />
              {part.alt}
            </div>
          )}
        </div>
      )}
      {previewOpen && (
        <MediaPreviewPanel
          target={target}
          onClose={() => setPreviewOpen(false)}
          onSaveEditedCopy={messageId ? saveEditedCopy : undefined}
        />
      )}
    </>
  );
}

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

type CreatorProposalDraft = JarvisCreatorAgentDraft | JarvisCreatorSkillDraft;

function ProposalRows({
  label,
  entries,
  empty,
}: {
  label: string;
  entries: string[];
  empty: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-metadata text-foreground/90">
        {entries.length > 0 ? entries.join(' · ') : empty}
      </dd>
    </div>
  );
}

function CreatorProposalCard({
  kind,
  draft,
  onApply,
}: {
  kind: JarvisCreatorKind;
  draft: CreatorProposalDraft;
  onApply: () => void;
}) {
  const proposal = draft.proposal ?? {
    purpose: draft.description,
    triggers: [],
    permitted: 'tools_allowed' in draft ? draft.tools_allowed : draft.tools,
    approvals: ['Ask for confirmation before actions outside the editor.'],
    inputs: [],
    outputs: [kind === 'agent' ? 'A configured custom agent draft.' : 'A VibeSpace skill-package preview.'],
    verification: ['Review the draft with the user before saving.'],
  };
  let packagePreview: ReturnType<typeof buildVibeSpaceSkillPackage> | null = null;
  if (kind === 'skill') {
    try {
      packagePreview = buildVibeSpaceSkillPackage(draft as JarvisCreatorSkillDraft);
    } catch {
      // A malformed model title should never prevent the user from reviewing
      // or safely applying the editable draft.
      packagePreview = null;
    }
  }
  const noun = kind === 'agent' ? 'agent' : 'skill';

  return (
    <section
      aria-label={`${noun} proposal`}
      className="mt-2 max-w-xl rounded-lg border border-accent-copper/35 bg-accent-copper/5 p-3"
    >
      <h3 className="text-body font-semibold text-foreground">Proposal</h3>
      <p className="mt-1 text-metadata text-foreground/85">{proposal.purpose}</p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <ProposalRows label="Triggers" entries={proposal.triggers} empty="On the reviewed request" />
        <ProposalRows label="Inputs" entries={proposal.inputs} empty="Ask for minimum needed context" />
        <ProposalRows label="Allowed scope" entries={proposal.permitted} empty="No tools approved by default" />
        <ProposalRows label="Approval boundaries" entries={proposal.approvals} empty="Ask before actions outside the editor" />
        <ProposalRows label="Outputs" entries={proposal.outputs} empty="Use the agreed result format" />
        <ProposalRows label="Verification" entries={proposal.verification} empty="Review with the user before saving" />
      </dl>
      {packagePreview ? (
        <div className="mt-3 rounded-md border border-border/70 bg-background/55 p-2 text-metadata text-foreground/85">
          <p className="font-medium">VibeSpace skill package preview</p>
          <ul className="mt-0.5 flex flex-wrap gap-x-2 text-muted-foreground" aria-label="Package preview files">
            {packagePreview.files.map((file) => (
              <li key={file.path}>{file.path.split('/').slice(-1)[0]}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">VibeSpace-authored preview; no package is written or installed yet.</p>
        </div>
      ) : null}
      <p className="mt-3 text-metadata text-muted-foreground">
        Apply this proposal only fills the editor. Save confirms and creates the {noun}.
      </p>
      <button
        type="button"
        aria-label={`Review and apply proposal to ${noun} — Push to ${noun}`}
        className="mt-2 w-fit rounded-md border border-accent-copper/45 bg-accent-copper/10 px-2 py-1 text-metadata text-foreground hover:border-accent-copper/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper"
        onClick={onApply}
      >
        Review &amp; apply proposal
      </button>
    </section>
  );
}

function CreatorDraftApply({ text, kind }: { text: string; kind?: JarvisCreatorKind }) {
  if (!kind) return null;

  if (kind === 'agent') {
    const parsed = parseJarvisCreatorDraft('agent', text);
    const resolved = parsed.ok ? parsed : parseLooseJarvisCreatorAgentDraft(text);
    if (!resolved.ok) return null;
    const draft = resolved.draft;
    return (
      <CreatorProposalCard
        kind="agent"
        draft={draft}
        onApply={() => window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_AGENT_EVENT, { detail: draft }))}
      />
    );
  }

  const parsed = parseJarvisCreatorDraft('skill', text);
  const resolved = parsed.ok ? parsed : parseLooseJarvisCreatorSkillDraft(text);
  if (!resolved.ok) return null;
  const draft = normalizeJarvisCreatorSkillDraft(resolved.draft);
  if (!draft) return null;
  return (
    <CreatorProposalCard
      kind="skill"
      draft={draft}
      onApply={() => window.dispatchEvent(new CustomEvent(JARVIS_CREATOR_APPLY_SKILL_EVENT, { detail: draft }))}
    />
  );
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
  /** Uses the shared safe Markdown presentation for assistant prose. */
  richText?: boolean;
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
  richText = false,
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
          {richText ? (
            <AssistantRichText
              text={display || part.text}
              className={hiveWords ? 'hive-words text-body font-medium' : 'text-body'}
            />
          ) : (
            <div
              className={
                hiveWords
                  ? 'hive-words text-body font-medium whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed'
                  : 'text-body text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed'
              }
            >
              {display || part.text}
            </div>
          )}
          <CreatorDraftApply text={part.text} kind={creatorDraftKind} />
        </div>
      );
    }

    case 'reasoning': {
      return <ThinkingDisclosure text={part.text} />;
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

    case 'provider_error': {
      const error = part.error;
      const presentation = presentProviderError(error);
      const route = [error.providerId, error.modelId].filter(Boolean).join('/');
      const retry = error.retryable === undefined
        ? undefined
        : error.retryable
          ? 'Retry may be available'
          : 'Retry is not available';
      const retryAfter = error.retryAfterMs === undefined
        ? undefined
        : `Retry after ${Math.ceil(error.retryAfterMs / 1_000)}s`;
      return (
        <div
          role="alert"
          data-testid="provider-error"
          data-provider-error-layout="wide"
          className="w-full max-w-none rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2.5"
        >
          <div className="text-metadata font-semibold uppercase tracking-wide text-destructive">
            {presentation.title}
          </div>
          <p className="mt-1 text-body whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {presentation.message}
          </p>
          {error.code || route || error.connectionId || retry || retryAfter || error.resetAt !== undefined || error.requestId || error.runId ? (
            <dl data-provider-error-diagnostics="true" className="mt-2.5 grid min-w-0 gap-x-6 gap-y-1 text-metadata text-muted-foreground sm:grid-cols-3">
              {error.code && !presentation.usageLimit ? <div className="min-w-0"><dt className="inline font-medium">Code: </dt><dd className="inline break-all">{error.code}</dd></div> : null}
              {route ? <div className="min-w-0"><dt className="inline font-medium">Route: </dt><dd className="inline break-all">{route}</dd></div> : null}
              {error.connectionId ? <div className="min-w-0"><dt className="inline font-medium">Connection: </dt><dd className="inline break-all">{error.connectionId}</dd></div> : null}
              {retry ? <div className="min-w-0"><dt className="inline font-medium">Retry: </dt><dd className="inline">{retry}</dd></div> : null}
              {retryAfter ? <div className="min-w-0"><dt className="inline font-medium">Timing: </dt><dd className="inline">{retryAfter}</dd></div> : null}
              {error.resetAt !== undefined ? <div className="min-w-0"><dt className="inline font-medium">Reset at: </dt><dd className="inline break-all">{error.resetAt}</dd></div> : null}
              {error.requestId ? <div className="min-w-0"><dt className="inline font-medium">Request: </dt><dd className="inline break-all">{error.requestId}</dd></div> : null}
              {error.runId ? <div className="min-w-0"><dt className="inline font-medium">Run: </dt><dd className="inline break-all">{error.runId}</dd></div> : null}
            </dl>
          ) : null}
          {presentation.usageLimit && (error.message || error.code) ? (
            <details className="mt-2 rounded-md border border-border/60 bg-background/25 px-3 py-1.5 text-metadata">
              <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                Technical details
              </summary>
              <dl className="mt-2 grid gap-y-1 text-muted-foreground sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4">
                {error.message ? (
                  <div className="contents">
                    <dt className="font-medium">Provider message</dt>
                    <dd className="break-words [overflow-wrap:anywhere]">{error.message}</dd>
                  </div>
                ) : null}
                {error.code ? (
                  <div className="contents">
                    <dt className="font-medium">Code</dt>
                    <dd className="break-all font-mono">{error.code}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          ) : null}
        </div>
      );
    }

    case 'action_proposal': {
      const pluginEvidence = resolvePluginActionEvidence(part, allParts);
      if (pluginEvidence && part.status !== 'pending') {
        return <PluginUsageCard part={part} allParts={allParts} />;
      }
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
      return (
        <MessageImagePart
          part={part}
          allParts={allParts}
          messageId={messageId}
          compact={compactAttachments}
        />
      );
    }

    case 'file_ref': {
      const ref = part.ref;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-secondary text-foreground">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-metadata">{ref.kind}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate max-w-[20ch]">
            {ref.kind === 'file' ? <ChatFileReference path={ref.id} chatId={chatId} /> : ref.id}
          </span>
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
          {uri && isContextEvidenceUri(uri) ? (
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline"
              aria-label={source.label}
              onClick={() => {
                void contextEvidenceNavigation.open({uri,chatId:chatId ?? '',messageId:messageId ? String(messageId) : ''})
                  .catch(error => {
                    if (error instanceof ContextEvidenceNavigationError && error.code === 'revoked') return;
                    toast.info('Context source is unavailable', 'This source reference is no longer available in the current project.');
                  });
              }}
            >
              {label}
            </button>
          ) : uri ? (
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

    case 'chat_handoff': {
      const handoff = part.handoff;
      const sentByTask = 'dispatch' in handoff && !!handoff.dispatch;
      return (
        <section
          aria-label={`Handoff from ${handoff.sourceTitle}`}
          className="max-w-xl rounded-md border border-accent-copper/30 bg-elevated px-3 py-2"
        >
          <div className="flex items-center gap-1.5 text-secondary font-semibold text-foreground">
            <FileText className="h-3.5 w-3.5 text-accent-copper" aria-hidden="true" />
            <span>Handoff from {handoff.sourceTitle}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-body text-foreground">
            {handoff.instruction}
          </p>
          {handoff.projection.goal ? (
            <p className="mt-1 text-secondary text-muted-foreground">
              Goal: <span className="text-foreground">{handoff.projection.goal}</span>
            </p>
          ) : null}
          <p className="mt-1 text-metadata text-muted-foreground">
            Safe context snapshot · {handoff.projection.status}
          </p>
          {sentByTask ? (
            <TaskMessageSourceLink sourceChatId={handoff.sourceChatId} recipientChatId={chatId} />
          ) : null}
        </section>
      );
    }

    case 'local_command_receipt':
      // Application metadata belongs to the session status, not user prose.
      return null;

    case 'codex_native_queue_receipt':
      if (part.state === 'started') return null;
      return (
        <div role="status" className="text-metadata text-muted-foreground">
          {part.state === 'review_required'
            ? 'Queued Codex turn needs review before retry.'
            : part.state === 'starting'
              ? 'Starting queued Codex turn…'
              : 'Queued on Codex. If this chat closes, review before retrying.'}
        </div>
      );

    default: {
      // Exhaustive check - new Part kinds will surface here at compile time.
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}
