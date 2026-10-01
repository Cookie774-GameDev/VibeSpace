import * as React from 'react';
import './sakura-wallpaper-library.css';
import { Download, Search, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth';
import { useAppAdmin } from '@/lib/admin';
import {
  clientMayApplyPremiumWallpaper,
  clientMayDownloadWallpaper,
  loadWallpaperCatalog,
  redeemOrbitWallpaper,
  requestWallpaperDownloadUrl,
  type CatalogLoadResult,
} from './catalogClient';
import { CATALOG_SEED } from './catalogSeed.generated';
import type { CatalogWallpaper, WallpaperAccessState } from './types';
import { ORBIT_SLOT_LIMIT } from './entitlementPolicy';
import { invoke } from '@tauri-apps/api/core';
import {
  deleteWallpaperBlob,
  isFullQualityCached,
  listWallpaperBlobIds,
  rehydrateWallpaperObjectUrl,
  storeDownloadedWallpaper,
  storeFullMasterPath,
} from './localWallpaperStore';
import { wallpaperPreviewSrc } from './previewUrl';
import { WallpaperPreviewThumb } from './WallpaperPreviewThumb';
import { useWorkbenchStore } from '@/features/workbench/store';
import { isTauri } from '@/lib/utils';
import type { WallpaperId } from '@/features/workbench/types';

function functionsBaseUrl(): string | null {
  const raw = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!raw) return null;
  return `${raw.replace(/\/$/, '')}/functions/v1`;
}

async function getAccessToken(): Promise<string | null> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const client = getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Temporary unlock so download/apply can be tested without subscription. */
const DEV_UNLOCK_ALL_WALLPAPERS = true;

export function WallpaperLibrary({
  onApplyWallpaper,
}: {
  onApplyWallpaper?: (id: WallpaperId, assetUrl?: string) => void;
} = {}) {
  const plan = useAuthStore((s) => s.plan);
  const isAdmin = useAppAdmin();
  const setWorkbenchWallpaper = useWorkbenchStore((s) => s.setWallpaper);
  const setWallpaper = onApplyWallpaper ?? setWorkbenchWallpaper;
  const [catalog, setCatalog] = React.useState<CatalogLoadResult | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'available' | 'featured'>('all');
  const [query, setQuery] = React.useState('');
  const [pending, setPending] = React.useState<CatalogWallpaper | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  /** Session object URLs rehydrated from IndexedDB bytes (not persisted as blob: strings). */
  const [localIds, setLocalIds] = React.useState<Record<string, string>>({});
  const objectUrlsRef = React.useRef<Record<string, string>>({});

  React.useEffect(() => {
    void (async () => {
      const token = await getAccessToken();
      const result = await loadWallpaperCatalog({
        accessToken: token,
        functionsBaseUrl: functionsBaseUrl(),
        seedCatalog: CATALOG_SEED,
      });
      // Merge local plan / admin when offline seed path has no access payload.
      // DEV unlock forces full catalog for testing downloads/apply.
      if (result.source !== 'network' || isAdmin || DEV_UNLOCK_ALL_WALLPAPERS) {
        result.access = {
          ...result.access,
          plan: String(plan ?? result.access.plan ?? 'free'),
          is_admin: result.access.is_admin || isAdmin || DEV_UNLOCK_ALL_WALLPAPERS,
          mode:
            DEV_UNLOCK_ALL_WALLPAPERS || isAdmin || result.access.is_admin
              ? 'full_catalog'
              : result.access.mode,
          status: DEV_UNLOCK_ALL_WALLPAPERS ? 'active' : result.access.status,
        };
      }
      setCatalog(result);

      // Rehydrate durable downloads after restart.
      try {
        const ids = await listWallpaperBlobIds();
        const next: Record<string, string> = {};
        for (const id of ids) {
          const url = await rehydrateWallpaperObjectUrl(id);
          if (url) next[id] = url;
        }
        objectUrlsRef.current = next;
        setLocalIds(next);
      } catch {
        // IndexedDB unavailable — downloads still work in-session after fetch.
      }
    })();
    return () => {
      for (const url of Object.values(objectUrlsRef.current)) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    };
  }, [plan, isAdmin]);

  const access: WallpaperAccessState = React.useMemo(() => {
    const base = catalog?.access ?? {
      mode: 'none' as const,
      plan: String(plan ?? 'free'),
      status: 'inactive',
      period_end: null,
      is_admin: false,
      orbit_wallpaper_ids: [] as string[],
    };
    if (DEV_UNLOCK_ALL_WALLPAPERS || isAdmin || base.is_admin) {
      return {
        ...base,
        is_admin: true,
        mode: 'full_catalog' as const,
        status: base.status === 'inactive' ? 'active' : base.status,
      };
    }
    return base;
  }, [catalog?.access, isAdmin, plan]);

  const slotsUsed = access.orbit_wallpaper_ids?.length ?? 0;

  const items = (catalog?.wallpapers ?? []).filter((w) => {
    if (filter === 'featured' && !w.featured) return false;
    if (filter === 'available') {
      if (!clientMayDownloadWallpaper({ wallpaperId: w.id, access })) return false;
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${w.name} ${w.category} ${(w.tags ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const accessBanner = () => {
    if (DEV_UNLOCK_ALL_WALLPAPERS) {
      return {
        title: 'Test unlock',
        body: 'All wallpapers unlocked for download/apply testing (temporary).',
      };
    }
    if (access.is_admin || access.mode === 'full_catalog') {
      return access.is_admin
        ? { title: 'Admin Access', body: 'All wallpapers unlocked' }
        : { title: 'Nova Wallpaper Collection', body: 'Every VibeSpace wallpaper is unlocked' };
    }
    if (access.mode === 'orbit_slots') {
      return {
        title: 'Orbit Wallpapers',
        body: `2 wallpaper choices included · ${slotsUsed} of ${ORBIT_SLOT_LIMIT} selected`,
      };
    }
    return {
      title: 'Premium wallpapers locked',
      body: 'Upgrade to Orbit ($10) for two wallpapers or Nova ($50) for the full collection.',
    };
  };

  const banner = accessBanner();

  const confirmOrbit = async (wallpaper: CatalogWallpaper) => {
    const token = await getAccessToken();
    if (!token) {
      toast.warning(
        'Sign in required',
        'Cloud subscription is required to redeem Orbit wallpapers.',
      );
      return;
    }
    const base = functionsBaseUrl();
    if (!base) {
      toast.warning('Cloud not configured', 'Supabase URL is not set for this build.');
      return;
    }
    setBusyId(wallpaper.id);
    try {
      const result = await redeemOrbitWallpaper({
        accessToken: token,
        functionsBaseUrl: base,
        wallpaperId: wallpaper.id,
      });
      if (!result.ok) {
        toast.warning('Could not redeem slot', result.reason ?? 'Request rejected');
        return;
      }
      toast.success('Orbit slot assigned', `${wallpaper.name} is now one of your two wallpapers.`);
      const refreshed = await loadWallpaperCatalog({
        accessToken: token,
        functionsBaseUrl: base,
        seedCatalog: CATALOG_SEED,
      });
      setCatalog(refreshed);
      setPending(null);
    } finally {
      setBusyId(null);
    }
  };

  const rememberLocal = (wallpaperId: string, url: string) => {
    const prev = objectUrlsRef.current[wallpaperId];
    if (prev?.startsWith('blob:') && prev !== url) URL.revokeObjectURL(prev);
    objectUrlsRef.current = { ...objectUrlsRef.current, [wallpaperId]: url };
    setLocalIds({ ...objectUrlsRef.current });
  };

  /** Download the FULL master MP4 — never the tiny 1s catalog preview. */
  const download = async (wallpaper: CatalogWallpaper) => {
    if (!clientMayDownloadWallpaper({ wallpaperId: wallpaper.id, access })) {
      toast.warning('Not entitled', 'Redeem an Orbit slot or upgrade to Nova.');
      return;
    }
    setBusyId(wallpaper.id);
    try {
      // 1) Cloud signed full master when edge is live.
      const token = await getAccessToken();
      const base = functionsBaseUrl();
      if (token && base) {
        const grant = await requestWallpaperDownloadUrl({
          accessToken: token,
          functionsBaseUrl: base,
          wallpaperId: wallpaper.id,
        });
        if (grant.ok && grant.download_url) {
          toast.info('Downloading full wallpaper…', wallpaper.name);
          const res = await fetch(grant.download_url);
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size >= 500_000) {
              const url = await storeDownloadedWallpaper({
                wallpaperId: wallpaper.id,
                slug: grant.slug ?? wallpaper.slug,
                version: wallpaper.version,
                sha256: grant.sha256 ?? '',
                blob,
                fullQuality: true,
              });
              rememberLocal(wallpaper.id, url);
              toast.success(
                'Downloaded full wallpaper',
                `${wallpaper.name} · ${Math.round(blob.size / (1024 * 1024))} MB`,
              );
              return;
            }
            toast.warning('Server file too small', 'Trying local full master instead…');
          }
        }
      }

      // 2) Local full masters from Downloads/VibeSpace-WallpAPPERS → app data cache.
      if (isTauri) {
        toast.info('Importing full master…', 'Copying the complete MP4 (max quality)');
        const cached = await invoke<{
          path: string;
          size_bytes: number;
          slug: string;
        }>('wallpaper_cache_full_master', {
          slug: wallpaper.slug,
          wallpaperId: wallpaper.id,
          mastersDir: null,
        });
        if (!cached?.path || !cached.size_bytes || cached.size_bytes < 500_000) {
          toast.warning(
            'Full master missing',
            'Could not find a full-quality MP4 for this wallpaper.',
          );
          return;
        }
        const url = await storeFullMasterPath({
          wallpaperId: wallpaper.id,
          slug: wallpaper.slug,
          version: wallpaper.version,
          sha256: wallpaper.sha256 ?? '',
          localPath: cached.path,
          sizeBytes: cached.size_bytes,
        });
        rememberLocal(wallpaper.id, url);
        toast.success(
          'Downloaded full wallpaper',
          `${wallpaper.name} · ${Math.round(cached.size_bytes / (1024 * 1024))} MB`,
        );
        return;
      }

      toast.warning(
        'Full download needs desktop',
        'Open the VibeSpace desktop app to import full-quality masters.',
      );
    } catch (e) {
      toast.warning(
        'Download failed',
        e instanceof Error ? e.message : 'Could not import full master',
      );
    } finally {
      setBusyId(null);
    }
  };

  const apply = async (wallpaper: CatalogWallpaper) => {
    const allowed = clientMayApplyPremiumWallpaper({
      wallpaperId: wallpaper.id,
      access,
      nowMs: Date.now(),
    });
    if (!allowed) {
      toast.warning('Wallpaper locked', 'No valid entitlement for this wallpaper.');
      return;
    }

    // Always prefer full-quality cache; never apply the tiny 1s catalog preview.
    let local = localIds[wallpaper.id];
    const full = await isFullQualityCached(wallpaper.id);
    if (!local || !full) {
      toast.info('Getting full quality…', 'Downloading the complete wallpaper first');
      await download(wallpaper);
      local = objectUrlsRef.current[wallpaper.id];
    }
    if (!local) {
      toast.warning('Apply failed', 'Full wallpaper is not available yet.');
      return;
    }
    setWallpaper('custom-video', local);
    toast.success('Wallpaper applied (full quality)', wallpaper.name);
  };

  const removeLocal = (wallpaper: CatalogWallpaper) => {
    void deleteWallpaperBlob(wallpaper.id);
    const prev = objectUrlsRef.current[wallpaper.id];
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
    const next = { ...objectUrlsRef.current };
    delete next[wallpaper.id];
    objectUrlsRef.current = next;
    setLocalIds(next);
    toast.info('Removed local copy', wallpaper.name);
  };

  return (
    <div className="wallpaper-library" data-testid="wallpaper-library">
      <header className="wallpaper-library-header">
        <div>
          <p className="wallpaper-library-kicker">Premium catalog</p>
          <h3>{banner.title}</h3>
          <span>{banner.body}</span>
        </div>
        <div className="wallpaper-library-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Search wallpapers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or category"
          />
        </div>
      </header>

      <div className="wallpaper-library-filters" role="tablist" aria-label="Wallpaper filters">
        {(['all', 'available', 'featured'] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={filter === f ? 'is-active' : undefined}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="wallpaper-library-grid">
        {items.map((w) => {
          const entitled = clientMayDownloadWallpaper({ wallpaperId: w.id, access });
          const downloaded = Boolean(localIds[w.id]);
          const orbitNeedsRedeem =
            access.mode === 'orbit_slots' &&
            !access.orbit_wallpaper_ids.includes(w.id) &&
            slotsUsed < ORBIT_SLOT_LIMIT;
          const locked = !entitled;
          return (
            <article key={w.id} className={`wallpaper-library-card${locked ? ' is-locked' : ''}`}>
              <WallpaperPreviewThumb wallpaper={w} locked={locked} />
              <div className="wallpaper-library-meta">
                <h4>{w.name}</h4>
                <p>
                  {w.category} · {w.performance_tier} · {Math.round(w.size_bytes / (1024 * 1024))}{' '}
                  MB
                </p>
                <span>
                  {entitled
                    ? downloaded
                      ? 'Downloaded'
                      : access.is_admin
                        ? 'Admin unlocked'
                        : 'Unlocked'
                    : orbitNeedsRedeem
                      ? 'Orbit slot available'
                      : 'Locked · preview only'}
                </span>
              </div>
              <footer>
                {orbitNeedsRedeem ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="accent"
                    disabled={busyId === w.id}
                    onClick={() => setPending(w)}
                  >
                    <Sparkles /> Use Orbit slot
                  </Button>
                ) : null}
                {entitled ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyId === w.id}
                      onClick={() => void download(w)}
                    >
                      <Download /> Download
                    </Button>
                    <Button type="button" size="sm" variant="accent" onClick={() => apply(w)}>
                      Apply
                    </Button>
                    {downloaded ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${w.name}`}
                        onClick={() => removeLocal(w)}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>

      {pending ? (
        <div
          className="wallpaper-library-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="orbit-confirm-title"
        >
          <div>
            <h3 id="orbit-confirm-title">Use an Orbit wallpaper slot?</h3>
            <p>
              You are selecting “{pending.name}”. This will use 1 of your {ORBIT_SLOT_LIMIT} Orbit
              wallpaper slots ({slotsUsed} already used). Selections stay assigned while Orbit
              remains active.
            </p>
            <div className="wallpaper-library-confirm-actions">
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="accent"
                disabled={busyId === pending.id}
                onClick={() => void confirmOrbit(pending)}
              >
                Confirm selection
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
