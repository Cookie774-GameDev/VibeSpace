import type { Message, Part } from '@/types';

export type ChatOutputAssetKind = 'image' | 'video' | 'file' | 'artifact';

export interface ChatOutputAsset {
  id: string;
  kind: ChatOutputAssetKind;
  name: string;
  mimeHint?: string;
  url?: string;
  path?: string;
  messageId: string;
  role: Message['role'];
  createdAt: number;
  side: 'input' | 'output';
}

function partAsset(message: Message, part: Part, index: number): ChatOutputAsset | null {
  if (part.kind === 'image') {
    const name = part.alt?.trim() || `image-${index + 1}`;
    const isUser = message.role === 'user';
    const isVideo = part.url.startsWith('data:video/');
    return {
      id: `${message.id}:image:${index}`,
      kind: isVideo ? 'video' : 'image',
      name,
      url: part.url,
      mimeHint: isVideo ? 'video' : 'image',
      messageId: message.id,
      role: message.role,
      createdAt: message.created_at,
      side: isUser ? 'input' : 'output',
    };
  }
  if (part.kind === 'file_ref') {
    const ref = part.ref;
    const name =
      ref.kind === 'file'
        ? (ref.id.split(/[/\\]/).pop() ?? ref.id)
        : ref.kind === 'memory'
          ? ref.id
          : String((ref as { id?: string }).id ?? 'file');
    const lower = name.toLowerCase();
    const kind: ChatOutputAssetKind = /\.(mp4|webm|mov|m4v)$/i.test(lower)
      ? 'video'
      : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower)
        ? 'image'
        : 'file';
    const isUser = message.role === 'user';
    return {
      id: `${message.id}:file:${index}`,
      kind,
      name,
      path: ref.kind === 'file' ? ref.id : undefined,
      messageId: message.id,
      role: message.role,
      createdAt: message.created_at,
      side: isUser ? 'input' : 'output',
    };
  }
  if (part.kind === 'jarvis_artifact_ref') {
    const artifact = part.artifact;
    const name =
      (artifact as { label?: string; title?: string; path?: string }).label ||
      (artifact as { title?: string }).title ||
      (artifact as { path?: string }).path ||
      'artifact';
    return {
      id: `${message.id}:artifact:${index}`,
      kind: 'artifact',
      name: String(name),
      messageId: message.id,
      role: message.role,
      createdAt: message.created_at,
      side: message.role === 'user' ? 'input' : 'output',
    };
  }
  return null;
}

/** Pure inventory of intentional media/file inputs and model-produced assets. */
export function buildChatOutputInventory(messages: readonly Message[]): {
  inputs: ChatOutputAsset[];
  outputs: ChatOutputAsset[];
} {
  const inputs: ChatOutputAsset[] = [];
  const outputs: ChatOutputAsset[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => {
      const asset = partAsset(message, part, index);
      if (!asset) return;
      // Treat data:video as video cards.
      if (asset.url?.startsWith('data:video/')) {
        asset.kind = 'video';
      }
      if (asset.side === 'input') inputs.push(asset);
      else outputs.push(asset);
    });
  }
  return { inputs, outputs };
}
