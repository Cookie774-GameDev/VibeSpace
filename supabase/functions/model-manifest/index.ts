// @ts-nocheck — Supabase Deno runtime (URL imports + Deno globals); not type-checked
// by the app's Node tsc. See supabase/functions/README.md.
// model-manifest: returns public Kokoro-82M model download metadata.
// No secrets, no auth required. Used by the desktop app's ModelManager to
// download + checksum-verify the local TTS model files.
//
// HONEST BEHAVIOR: a real model asset (with real SHA-256 + sizes) is not bundled
// yet. Until MODEL_MANIFEST_URL (a published JSON manifest) is configured, this
// returns { status: "unavailable", files: [] } so the app does NOT attempt to
// download placeholder URLs and instead falls back to system TTS. We never ship
// fake checksums.

import { json } from '../_shared/voice.ts';

const MODEL_MANIFEST_URL = Deno.env.get('MODEL_MANIFEST_URL') ?? '';

// Presets are static + safe to advertise (they map to Kokoro voice ids used
// once a real model is installed). No file URLs/checksums here on purpose.
const PRESETS = {
  jarvis: { voice: 'bm_daniel', speed: 0.94 },
  friday: { voice: 'bf_emma', speed: 1.05 },
};

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });

  if (MODEL_MANIFEST_URL) {
    try {
      const res = await fetch(MODEL_MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const remote = await res.json();
        return json({ status: 'available', ...remote }, 200, origin);
      }
    } catch {
      // fall through to unavailable
    }
  }

  // No real manifest configured/reachable: be explicit so the client falls back.
  return json(
    {
      status: 'unavailable',
      reason: 'model_artifact_not_published',
      model: 'kokoro-82m',
      runtime: 'onnx',
      files: [],
      voices: ['bm_daniel', 'bf_emma'],
      presets: PRESETS,
    },
    200,
    origin,
  );
});
