import { useEffect, useState } from 'react';
import { toast } from '@/components/ui';
import {
  CONTEXT_AUTO_UPDATE_EVENT,
  contextAutoFingerprint,
  readContextAutoUpdate,
  setContextAutoUpdate,
  type ContextAutoUpdateSetting,
} from './contextAutoUpdate';
import type { ContextMapRecord } from './tree';

export function ContextAutoUpdateCheckbox({
  accountId,
  workspaceId,
  map,
}: {
  accountId: string | null;
  workspaceId: string | null;
  map: ContextMapRecord;
}) {
  const [setting, setSetting] = useState<ContextAutoUpdateSetting | null>(null);
  const [pending, setPending] = useState(false);
  const available = Boolean(
    accountId &&
    workspaceId &&
    map.projectId &&
    map.status === 'active' &&
    (!map.sourceType || map.sourceType === 'local_folder'),
  );
  useEffect(() => {
    setSetting(null);
    if (!available) return;
    let live = true;
    const refresh = () =>
      void readContextAutoUpdate({
        accountId: accountId!,
        workspaceId: workspaceId!,
        projectId: map.projectId!,
        mapId: map.id,
      })
        .then((value) => {
          if (live) setSetting(value);
        })
        .catch(() => {
          if (live) setSetting(null);
        });
    refresh();
    window.addEventListener(CONTEXT_AUTO_UPDATE_EVENT, refresh);
    return () => {
      live = false;
      window.removeEventListener(CONTEXT_AUTO_UPDATE_EVENT, refresh);
    };
  }, [available, accountId, workspaceId, map.projectId, map.id, map.updatedAt]);
  const settingInScope =
    setting?.accountId === accountId &&
    setting?.workspaceId === workspaceId &&
    setting?.projectId === map.projectId &&
    setting?.mapId === map.id;
  const checked = Boolean(
    settingInScope && setting?.enabled && setting.fingerprint === contextAutoFingerprint(map),
  );
  return (
    <div className="text-metadata">
      <label
        className="flex items-center gap-2 text-foreground"
        title="Update saved files in this map while VibeSpace is open. No automatic model summaries."
      >
        <input
          type="checkbox"
          className="accent-accent-copper"
          aria-label={`Automatically update ${map.name}`}
          checked={checked}
          disabled={!available || pending}
          onChange={(event) => {
            if (!available) return;
            const enabled = event.target.checked;
            setPending(true);
            void setContextAutoUpdate(
              {
                accountId: accountId!,
                workspaceId: workspaceId!,
                projectId: map.projectId!,
                mapId: map.id,
              },
              map,
              enabled,
            )
              .then(() =>
                readContextAutoUpdate({
                  accountId: accountId!,
                  workspaceId: workspaceId!,
                  projectId: map.projectId!,
                  mapId: map.id,
                }),
              )
              .then(setSetting)
              .catch((error) =>
                toast.error(
                  'Automatic update needs review',
                  error instanceof Error ? error.message : 'Could not save this map setting',
                ),
              )
              .finally(() => setPending(false));
          }}
        />
        Automatically update
      </label>
      {checked && setting?.status === 'failed' ? (
        <p role="status" className="mt-1 text-muted-foreground">
          Update needs review. Search stays available. {setting.error}
        </p>
      ) : null}
      {settingInScope && setting?.enabled && !checked ? (
        <p className="mt-1 text-muted-foreground">
          Source or exclusions changed. Enable again to approve this scope.
        </p>
      ) : null}
    </div>
  );
}
