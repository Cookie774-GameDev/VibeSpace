/**
 * Entry/consumer checks against shipped builders and pull path.
 * Install-with-consent UI flow is covered by LocalModels.runtime.test.tsx
 * (real LocalModels Download click → consent → install → pull), not mocks here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildOllamaRequestBody,
  toOllamaNativeMessages,
  pullOllamaModel,
} from './providers/ollama';
import { ollamaModelSupportsVision, modelSupportsVision } from './vision';
import { writeLocalAgentPreferences } from './localAgentRuntime';
import { classifyBrowserFilesForAttach } from '@/features/chat/imageAttachments';

describe('shipped multimodal + Ollama entry contracts', () => {
  beforeEach(() => {
    writeLocalAgentPreferences({ mode: 'fast', cloudEscalationEnabled: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('vision Ollama request body carries real image fields (not [Image:] text)', () => {
    expect(ollamaModelSupportsVision('llava:latest')).toBe(true);
    expect(modelSupportsVision('ollama', 'llama3.2-vision')).toBe(true);
    expect(modelSupportsVision('ollama', 'llama3.2:1b')).toBe(false);

    const body = buildOllamaRequestBody(
      {
        agent: {
          id: 'a1' as any,
          slug: 'jarvis',
          name: 'Jarvis',
          description: '',
          system_prompt: 'sys',
          model: { provider: 'ollama', model: 'llava' },
          tools_allowed: [],
          memory_scope: 'workspace',
          capabilities: [],
          created_at: 1,
          updated_at: 1,
        },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe' },
              {
                type: 'image',
                data: 'ZmFrZS1pbWFnZS1ieXRlcw==',
                mimeType: 'image/png',
                name: 'x.png',
              },
            ],
          },
        ],
      },
      'llava',
    );

    const user = body.messages.find((m) => m.role === 'user');
    expect(user?.images?.[0]).toBe('ZmFrZS1pbWFnZS1ieXRlcw==');
    expect(JSON.stringify(body.messages)).not.toMatch(/\[Image:/);
    expect(body.vision).toBe(true);
  });

  it('text-only local path does not claim vision images[]', () => {
    const native = toOllamaNativeMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', data: 'abc', mimeType: 'image/png' },
          ],
        },
      ],
      { vision: false },
    );
    expect(native[0]?.images).toBeUndefined();
  });

  it('Composer FileList helper keeps general files in mixed media drops', () => {
    // Drives the same classifyBrowserFilesForAttach entry Composer uses on paste/drop.
    const image = new File(['png'], 'a.png', { type: 'image/png' });
    const video = new File(['vid'], 'b.mp4', { type: 'video/mp4' });
    const doc = new File(['# note'], 'note.md', { type: 'text/markdown' });
    Object.defineProperty(doc, 'path', { value: 'C:\\work\\note.md', configurable: true });
    const textOnly = new File(['hello'], 'clip.txt', { type: 'text/plain' });

    const classified = classifyBrowserFilesForAttach([image, video, doc, textOnly]);
    expect(classified.images.map((f) => f.name)).toEqual(['a.png']);
    expect(classified.videos.map((f) => f.name)).toEqual(['b.mp4']);
    expect(classified.pathFiles.map((e) => e.path)).toEqual(['C:\\work\\note.md']);
    expect(classified.textWithoutPath.map((f) => f.name)).toEqual(['clip.txt']);
  });

  it('pullOllamaModel invokes progress callbacks on the shipped pull path', async () => {
    const progress: string[] = [];
    let tagsCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        tagsCalls += 1;
        const models = tagsCalls > 1 ? [{ name: 'tiny-test:latest' }] : [];
        return Promise.resolve(
          new Response(JSON.stringify({ models }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/pull')) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\n',
              ),
            );
            controller.enqueue(enc.encode(JSON.stringify({ status: 'success' }) + '\n'));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await pullOllamaModel('tiny-test:latest', (event) => {
      progress.push(event.status);
    });
    expect(progress.some((status) => /download|success|pulling|manifest/i.test(status))).toBe(true);
  });
});
