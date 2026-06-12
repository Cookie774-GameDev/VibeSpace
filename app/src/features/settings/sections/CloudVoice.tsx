import { useEffect, useState } from 'react';
import { Cloud, Download, Play, Square, RefreshCw, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  VOICE_PROVIDERS,
  VOICE_PRESETS,
  usageCopy,
  deepgramPromoCopy,
  type VoiceProviderId,
  type VoiceTtsPreset,
  type VoicePlanId,
} from '@/features/voice/voicePlans';
import { TtsService, type VoiceUsageSnapshot } from '@/features/voice/TtsService';
import { ModelManager, type DownloadProgress } from '@/features/voice/modelManager';
import {
  getMessageUsage,
  getCallUsage,
  messageUsageCopy,
  callUsageCopy,
  type MessageUsage,
  type CallUsage,
  type BillingPlanId,
} from '@/features/billing/planLimits';

const PROVIDER_PREF_KEY = 'jarvis.voice.cloudProvider';
const PRESET_PREF_KEY = 'jarvis.voice.ttsPreset';

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (window.localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const PROVIDER_ORDER: VoiceProviderId[] = [
  'kokoro_local',
  'openai_tts',
  'deepgram_tts',
  'elevenlabs_tts',
  'system_tts_fallback',
];

/**
 * Cloud Voice settings — adds the voice subscription controls described in the
 * master plan to the existing settings modal as its own tab. Purely additive;
 * does not modify the existing Voice (STT/persona) section.
 */
export function CloudVoice() {
  const [provider, setProvider] = useState<VoiceProviderId>(() =>
    readPref<VoiceProviderId>(PROVIDER_PREF_KEY, 'kokoro_local'),
  );
  const [preset, setPreset] = useState<VoiceTtsPreset>(() =>
    readPref<VoiceTtsPreset>(PRESET_PREF_KEY, 'jarvis'),
  );
  const [usage, setUsage] = useState<VoiceUsageSnapshot | null>(null);
  const [msgUsage, setMsgUsage] = useState<MessageUsage | null>(null);
  const [callUsageState, setCallUsageState] = useState<CallUsage | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    TtsService.setProvider(provider);
  }, [provider]);
  useEffect(() => {
    TtsService.setVoicePreset(preset);
  }, [preset]);
  useEffect(() => {
    const off = TtsService.onNotice((m) => setNotice(m));
    return off;
  }, []);

  function chooseProvider(id: VoiceProviderId) {
    setProvider(id);
    writePref(PROVIDER_PREF_KEY, id);
  }
  function choosePreset(id: VoiceTtsPreset) {
    setPreset(id);
    writePref(PRESET_PREF_KEY, id);
  }

  async function onTest() {
    setNotice('');
    await TtsService.testVoice(preset);
  }
  function onStop() {
    TtsService.stop();
  }
  async function onViewUsage() {
    const u = await TtsService.getUsage();
    setUsage(u);
    if (!u) setNotice('Sign in to view cloud voice usage. Local Kokoro voice is always available.');
  }
  async function onViewMessageUsage() {
    setMsgUsage(await getMessageUsage());
  }
  async function onViewCallUsage() {
    setCallUsageState(await getCallUsage());
  }
  async function onDownloadRepair() {
    setDownloading(true);
    setProgress(null);
    const ok = await ModelManager.ensureKokoroReady((p) => setProgress(p));
    setDownloading(false);
    setNotice(
      ok
        ? 'Local voice model is ready.'
        : 'Local voice model could not be prepared here. It will download inside the desktop app.',
    );
  }

  const planId = (usage?.plan as VoicePlanId | undefined) ?? 'free';

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-accent-cyan" />
          <h2 className="text-heading text-foreground">Cloud Voice</h2>
        </div>
        <p className="text-secondary text-muted-foreground mt-1">
          Choose how Jarvis speaks. Local Kokoro voice is free and unlimited; cloud voices use your
          plan&apos;s monthly budget and fall back to Kokoro automatically.
        </p>
      </div>

      {/* Voice Provider */}
      <section className="space-y-2">
        <Label>Voice Provider</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDER_ORDER.map((id) => {
            const info = VOICE_PROVIDERS[id];
            const active = provider === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => chooseProvider(id)}
                aria-pressed={active}
                className={cn(
                  'flex items-center justify-between rounded-md border bg-panel p-3 text-left transition-colors',
                  'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  active
                    ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
                    : 'border-border',
                )}
              >
                <span className="text-ui-strong text-foreground">{info.label}</span>
                {info.cloud && (
                  <span className="text-metadata text-muted-foreground">Paid plan</span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Voice Preset */}
      <section className="space-y-2">
        <Label>Voice Preset</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(VOICE_PRESETS) as VoiceTtsPreset[]).map((id) => {
            const def = VOICE_PRESETS[id];
            const active = preset === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => choosePreset(id)}
                aria-pressed={active}
                className={cn(
                  'rounded-md border bg-panel p-3 text-left transition-colors hover:bg-elevated',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  active
                    ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
                    : 'border-border',
                )}
              >
                <span className="block text-ui-strong text-foreground">{def.label}</span>
                <span className="block text-metadata text-muted-foreground">{def.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Buttons */}
      <section className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onTest}>
          <Play className="h-4 w-4 mr-1.5" /> Test Voice
        </Button>
        <Button type="button" variant="secondary" onClick={onStop}>
          <Square className="h-4 w-4 mr-1.5" /> Stop Speaking
        </Button>
        <Button type="button" variant="secondary" onClick={onDownloadRepair} disabled={downloading}>
          {downloading ? (
            <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-1.5" />
          )}
          Download / Repair Local Voice Model
        </Button>
        <Button type="button" variant="secondary" onClick={onViewUsage}>
          <Gauge className="h-4 w-4 mr-1.5" /> View Voice Usage
        </Button>
        <Button type="button" variant="secondary" onClick={onViewMessageUsage}>
          <Gauge className="h-4 w-4 mr-1.5" /> View Message Usage
        </Button>
        <Button type="button" variant="secondary" onClick={onViewCallUsage}>
          <Gauge className="h-4 w-4 mr-1.5" /> View Call Usage
        </Button>
      </section>

      {(msgUsage || callUsageState) && (
        <section className="rounded-md border border-border bg-panel p-3 space-y-1">
          {msgUsage && (
            <p className="text-secondary text-foreground">
              {messageUsageCopy(msgUsage, (msgUsage.plan as BillingPlanId) ?? 'free')}
            </p>
          )}
          {callUsageState && (
            <p className="text-secondary text-foreground">
              {callUsageCopy(callUsageState, (callUsageState.plan as BillingPlanId) ?? 'free')}
            </p>
          )}
          <p className="text-metadata text-muted-foreground">
            Local voice remains available regardless of company AI usage.
          </p>
        </section>
      )}

      {progress && (
        <p className="text-metadata text-muted-foreground">
          Downloading {progress.file}: {Math.round(progress.percent)}%
        </p>
      )}

      {/* Usage display */}
      {usage && (
        <section className="rounded-md border border-border bg-panel p-3">
          <p className="text-secondary text-foreground">
            {usageCopy(planId, usage.monthly_seconds_used, usage.monthly_seconds_limit)}
          </p>
          {usage.deepgram_promo && usage.deepgram_promo.seconds_limit > 0 && (
            <p className="text-secondary text-foreground mt-2">
              {deepgramPromoCopy(
                planId,
                usage.deepgram_promo.seconds_used,
                usage.deepgram_promo.seconds_limit,
              )}
            </p>
          )}
          <p className="text-metadata text-muted-foreground mt-1">
            Plan: {planId} · Local voice {usage.local_voice_available ? 'available' : 'unavailable'} ·
            Cloud voice {usage.cloud_voice_available ? 'available' : 'unavailable'}
          </p>
        </section>
      )}

      {notice && <p className="text-secondary text-accent-cyan">{notice}</p>}
    </div>
  );
}
