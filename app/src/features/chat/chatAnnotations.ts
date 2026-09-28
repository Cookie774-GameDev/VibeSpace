export interface ChatAnnotation {
  readonly id: string;
  readonly text: string;
  readonly comment: string;
}

export const CHAT_ANNOTATION_ATTACH_EVENT = 'jarvis:chat:annotation-attach';

export interface ChatAnnotationAttachDetail {
  readonly chatId: string;
  readonly text: string;
  readonly anchor?: { readonly top: number; readonly left: number };
}

export function appendChatAnnotations(
  message: string,
  annotations: readonly ChatAnnotation[],
): string {
  if (annotations.length === 0) return message.trim();
  const references = annotations.map((annotation, index) => {
    const quote = annotation.text
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const comment = annotation.comment.trim();
    return `Annotation ${index + 1}:\n${quote}${comment ? `\nComment: ${comment}` : ''}`;
  });
  return [message.trim(), ...references].filter(Boolean).join('\n\n');
}
