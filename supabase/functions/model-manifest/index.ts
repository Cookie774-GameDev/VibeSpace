// @ts-nocheck
// model-manifest: returns public Kokoro-82M model download metadata.
// No secrets, no auth required. Used by the desktop app's ModelManager to
// download + checksum-verify the local TTS model files.
//
// The actual file URLs/checksums are provided via the MODEL_MANIFEST_URL or
// GITHUB_MODEL_RELEASE_URL secret (a JSON document), or fall back to the
// built-in default below so the endpoint always returns something usable.

import { json } from '../_shared/voice.ts';

const MODEL_MANIFEST_URL = Deno.env.get('MODEL_MANIFEST_URL') ?? '';
const GITHUB_MODEL_RELEASE_URL = Deno.env.get('GITHUB_MODEL_RELEASE_URL') ?? '';

// Default manifest. Replace checksums/sizes/urls with real release assets once
// the Kokoro model is published to a GitHub release.
const DEFAULT_MANIFEST = {
  model: 'kokoro-82m',
  version: '1.0.0',
  runtime: 'onnx',
  files: [
    {
      name: 'kokoro-v1.0.int8.onnx',
      url: `${GITHUB_MODEL_RELEASE_URL || 'https://github.com/Cookie774-GameDev/Jarivs-One/releases/download/kokoro-v1.0'}/kokoro-v1.0.int8.onnx`,
      sha256: 'REPLACE_WITH_REAL_SHA256',
      size_bytes: 0,
      required: true,
    },
    {
      name: 'voices.bin',
      url: `${GITHUB_MODEL_RELEASE_URL || 'https://github.com/Cookie774-GameDev/Jarivs-One/releases/download/kokoro-v1.0'}/voices.bin`,
      sha256: 'REPLACE_WITH_REAL_SHA256',
      size_bytes: 0,
      required: true,
    },
  ],
  voices: ['bm_daniel', 'bf_emma'],
  presets: {
    jarvis: { voice: 'bm_daniel', speed: 0.94 },
    friday: { voice: 'bf_emma', speed: 1.05 },
  },
};

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });

  if (MODEL_MANIFEST_URL) {
    try {
      const res = await fetch(MODEL_MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const remote = await res.json();
        return json(remote, 200, origin);
      }
    } catch {
      // fall through to default
    }
  }
  return json(DEFAULT_MANIFEST, 200, origin);
});
