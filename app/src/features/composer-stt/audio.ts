type AudioContextCtor = typeof AudioContext;

export function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? ((window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ?? null);
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    offset += value.length;
  };
  writeString('RIFF');
  view.setUint32(offset, 36 + sampleCount * 2, true); offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  writeString('data');
  view.setUint32(offset, sampleCount * 2, true); offset += 4;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function cleanupAudioRecorder(
  processor: ScriptProcessorNode | null,
  source: MediaStreamAudioSourceNode | null,
  context: AudioContext | null,
  stream: MediaStream | null,
): void {
  try { processor?.disconnect(); } catch { /* already disconnected */ }
  try { source?.disconnect(); } catch { /* already disconnected */ }
  try { void context?.close(); } catch { /* already closed */ }
  stream?.getTracks().forEach((t) => t.stop());
}
