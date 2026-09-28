import { Copy, MessageSquarePlus, Sparkles } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { toast } from '@/components/ui/toast';
import { CHAT_ANNOTATION_ATTACH_EVENT } from './chatAnnotations';

interface SelectionPopup {
  text: string;
  top: number;
  left: number;
}

export function ChatSelectionToolbar({
  chatId,
  rootRef,
}: {
  chatId: string;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const [selection, setSelection] = useState<SelectionPopup | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const selected = window.getSelection();
      const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
      const log = root.querySelector('[data-tour="chat-thread"]');
      if (
        !selected ||
        !range ||
        selected.isCollapsed ||
        !log ||
        !log.contains(range.startContainer) ||
        !log.contains(range.endContainer)
      ) {
        setSelection(null);
        return;
      }
      const text = selected.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelection({
        text,
        top: Math.max(8, rect.top - 42),
        left: Math.max(8, Math.min(window.innerWidth - 320, rect.left)),
      });
    };
    const hide = () => setSelection(null);
    root.addEventListener('mouseup', update);
    root.addEventListener('keyup', update);
    root.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      root.removeEventListener('mouseup', update);
      root.removeEventListener('keyup', update);
      root.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [rootRef]);

  const attach = (ask: boolean) => {
    if (!selection) return;
    window.dispatchEvent(
      new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
        detail: { chatId, text: selection.text, ask },
      }),
    );
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  const copy = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed', 'Clipboard is not available.');
    }
    setSelection(null);
  };

  if (!selection) return null;
  return (
    <div
      className="fixed z-50 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-0.5 rounded-full border border-accent-copper/40 bg-panel/95 px-1 py-0.5 shadow-lg backdrop-blur"
      style={{ top: selection.top, left: selection.left }}
      role="toolbar"
      aria-label="Selected chat text"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-foreground hover:bg-accent-copper/15"
        onClick={() => void copy()}
      >
        <Copy className="h-3 w-3" /> Copy
      </button>
      <span className="h-3 w-px bg-border" aria-hidden />
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-accent-copper hover:bg-accent-copper/15"
        onClick={() => attach(true)}
      >
        <Sparkles className="h-3 w-3" /> Ask Jarvis
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-accent-copper hover:bg-accent-copper/15"
        onClick={() => attach(false)}
      >
        <MessageSquarePlus className="h-3 w-3" /> Attach to Chat
      </button>
    </div>
  );
}
