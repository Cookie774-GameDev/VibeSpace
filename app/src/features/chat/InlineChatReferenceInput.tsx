import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
  type ChangeEvent,
} from 'react';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';
import {
  chatReferenceToken,
  inlineChatSegments,
  readableReferenceText,
} from './inlineChatReference';
import './inline-chat-reference.css';

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  references: readonly ChatHandoffProjectionV1[];
  onOpenReference: (id: string) => void;
};

function editorText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.dataset.chatReference)
    return chatReferenceToken(node.dataset.chatReference);
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes).map(editorText).join('');
}
function editorSelection(root: HTMLElement): [number, number] {
  const selection = window.getSelection();
  if (
    !selection?.rangeCount ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return [editorText(root).length, editorText(root).length];
  const range = selection.getRangeAt(0);
  const offset = (node: Node, position: number) => {
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(node, position);
    return editorText(before.cloneContents()).length;
  };
  return [
    offset(range.startContainer, range.startOffset),
    offset(range.endContainer, range.endOffset),
  ];
}
function setEditorSelection(root: HTMLElement, start: number, end = start) {
  const point = (offset: number, after: boolean): [Node, number] => {
    let remaining = Math.max(0, offset);
    for (const child of Array.from(root.childNodes)) {
      const length = editorText(child).length;
      if (remaining <= length) {
        if (child.nodeType === Node.TEXT_NODE) return [child, Math.min(remaining, length)];
        const index = Array.prototype.indexOf.call(root.childNodes, child);
        return [root, index + (remaining === length || (remaining > 0 && after) ? 1 : 0)];
      }
      remaining -= length;
    }
    return [root, root.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(start, false));
  range.setEnd(...point(end, true));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function renderEditor(
  root: HTMLElement,
  text: string,
  references: readonly ChatHandoffProjectionV1[],
) {
  const fragment = document.createDocumentFragment();
  for (const segment of inlineChatSegments(text, references)) {
    if (!segment.reference) {
      fragment.append(document.createTextNode(segment.text));
      continue;
    }
    const chip = document.createElement('span');
    chip.dataset.chatReference = segment.reference.source.chatId;
    chip.contentEditable = 'false';
    chip.className = 'inline-chat-reference-token';
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.setAttribute('aria-label', `Reference ${segment.reference.source.title}`);
    chip.title = 'View chat reference · Delete removes the whole reference';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
    icon.append(path);
    const label = document.createElement('span');
    label.textContent = segment.reference.source.title;
    chip.append(icon, label);
    fragment.append(chip);
  }
  fragment.append(document.createTextNode(''));
  root.replaceChildren(fragment);
}

/** The plain composer stays a native textarea. With references, expose its existing
 * value/selection contract over an editable surface containing atomic chat tokens. */
export const InlineChatReferenceInput = forwardRef<HTMLTextAreaElement, Props>(
  function InlineChatReferenceInput({ references, onOpenReference, ...props }, forwardedRef) {
    const rootRef = useRef<HTMLDivElement>(null);
    const plainRef = useRef<HTMLTextAreaElement>(null);
    const composingRef = useRef(false);
    const renderedReferencesRef = useRef('');
    const pendingCaretRef = useRef<number | null>(null);
    const rich = references.length > 0;
    useImperativeHandle(
      forwardedRef,
      () => (rich ? rootRef.current : plainRef.current) as HTMLTextAreaElement,
      [rich],
    );
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      Object.defineProperties(root, {
        value: { configurable: true, get: () => editorText(root) },
        selectionStart: { configurable: true, get: () => editorSelection(root)[0] },
        selectionEnd: { configurable: true, get: () => editorSelection(root)[1] },
        setSelectionRange: {
          configurable: true,
          value: (start: number, end: number) => setEditorSelection(root, start, end),
        },
      });
    }, [rich]);
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root || composingRef.current) return;
      const value = String(props.value ?? '');
      const signature = JSON.stringify(
        references.map((reference) => [reference.source.chatId, reference.source.title]),
      );
      if (editorText(root) === value && renderedReferencesRef.current === signature) return;
      renderedReferencesRef.current = signature;
      const focused = root === document.activeElement || root.contains(document.activeElement);
      const [start, end] = editorSelection(root);
      renderEditor(root, value, references);
      if (focused)
        setEditorSelection(root, Math.min(start, value.length), Math.min(end, value.length));
    }, [props.value, references, rich]);
    useLayoutEffect(() => {
      if (!rich && pendingCaretRef.current !== null && plainRef.current) {
        plainRef.current.focus();
        plainRef.current.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
        pendingCaretRef.current = null;
      }
    }, [rich]);
    if (!rich) return <textarea {...props} ref={plainRef} />;
    const change = (root: HTMLDivElement, text: string, caret: number) => {
      renderEditor(root, text, references);
      root.focus();
      setEditorSelection(root, caret);
      pendingCaretRef.current = caret;
      props.onChange?.({
        target: root,
        currentTarget: root,
      } as unknown as ChangeEvent<HTMLTextAreaElement>);
    };
    const replaceSelection = (root: HTMLDivElement, inserted: string) => {
      const [start, end] = editorSelection(root);
      const text = editorText(root);
      change(root, text.slice(0, start) + inserted + text.slice(end), start + inserted.length);
    };
    const deleteAtomic = (root: HTMLDivElement, backward: boolean) => {
      let [start, end] = editorSelection(root);
      let offset = 0;
      const text = editorText(root);
      let touched = false;
      for (const segment of inlineChatSegments(text, references)) {
        const finish = offset + segment.text.length;
        if (
          segment.reference &&
          (start === end
            ? backward
              ? start === finish
              : start === offset
            : start < finish && end > offset)
        ) {
          start = Math.min(start, offset);
          end = Math.max(end, finish);
          touched = true;
        }
        offset = finish;
      }
      if (touched) change(root, text.slice(0, start) + text.slice(end), start);
      return touched;
    };
    return (
      <div
        {...Object.fromEntries(
          Object.entries(props).filter(
            ([key]) => key.startsWith('aria-') || key.startsWith('data-'),
          ),
        )}
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-label={props['aria-label']}
        data-composer-input="true"
        data-inline-chat-editor="true"
        data-placeholder={props.placeholder}
        className={`${props.className ?? ''} inline-chat-reference-input`}
        style={props.style}
        contentEditable={!props.disabled && !props.readOnly}
        suppressContentEditableWarning
        spellCheck={props.spellCheck}
        onInput={(event) => props.onChange?.(event as unknown as ChangeEvent<HTMLTextAreaElement>)}
        onCompositionStart={(event) => {
          composingRef.current = true;
          props.onCompositionStart?.(event as never);
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          props.onCompositionEnd?.(event as never);
          props.onChange?.(event as unknown as ChangeEvent<HTMLTextAreaElement>);
        }}
        onFocus={(event) => props.onFocus?.(event as never)}
        onBlur={(event) => props.onBlur?.(event as never)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const token = (event.target as HTMLElement).closest<HTMLElement>('[data-chat-reference]');
          if (token && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onOpenReference(token.dataset.chatReference!);
            return;
          }
          if (token && (event.key === 'Backspace' || event.key === 'Delete')) {
            event.preventDefault();
            const text = editorText(event.currentTarget),
              marker = chatReferenceToken(token.dataset.chatReference!),
              index = text.indexOf(marker);
            change(
              event.currentTarget,
              text.slice(0, index) + text.slice(index + marker.length),
              index,
            );
            return;
          }
          if (
            (event.key === 'Backspace' || event.key === 'Delete') &&
            deleteAtomic(event.currentTarget, event.key === 'Backspace')
          ) {
            event.preventDefault();
            return;
          }
          props.onKeyDown?.(event as never);
          if (event.key === 'Enter' && !event.defaultPrevented) {
            event.preventDefault();
            replaceSelection(event.currentTarget, '\n');
          }
        }}
        onBeforeInput={(event) => {
          const kind = (event.nativeEvent as InputEvent).inputType;
          if (
            (kind === 'deleteContentBackward' || kind === 'deleteContentForward') &&
            deleteAtomic(event.currentTarget, kind === 'deleteContentBackward')
          )
            event.preventDefault();
        }}
        onKeyUp={(event) => props.onKeyUp?.(event as never)}
        onClick={(event) => {
          const token = (event.target as HTMLElement).closest<HTMLElement>('[data-chat-reference]');
          if (token) {
            const text = editorText(event.currentTarget),
              marker = chatReferenceToken(token.dataset.chatReference!),
              start = text.indexOf(marker);
            setEditorSelection(event.currentTarget, start, start + marker.length);
            onOpenReference(token.dataset.chatReference!);
            return;
          }
          props.onClick?.(event as never);
        }}
        onPaste={(event) => {
          props.onPaste?.(event as never);
          if (event.defaultPrevented) return;
          event.preventDefault();
          replaceSelection(event.currentTarget, event.clipboardData.getData('text/plain'));
        }}
        onCopy={(event) => {
          const [start, end] = editorSelection(event.currentTarget);
          event.preventDefault();
          event.clipboardData.setData(
            'text/plain',
            readableReferenceText(editorText(event.currentTarget).slice(start, end), references),
          );
        }}
        onCut={(event) => {
          const [start, end] = editorSelection(event.currentTarget);
          event.preventDefault();
          event.clipboardData.setData(
            'text/plain',
            readableReferenceText(editorText(event.currentTarget).slice(start, end), references),
          );
          replaceSelection(event.currentTarget, '');
        }}
      />
    );
  },
);
