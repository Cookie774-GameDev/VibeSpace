import { useEffect, useState } from 'react';
import { DISPLAY_REFRESH_MS } from './usageRefreshPolicy';

function formatSyncAge(updatedAt: number, now: number): string {
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) return 'Not synced';
  const ageSeconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (ageSeconds < 5) return 'Updated just now';
  if (ageSeconds < 60) return `Updated ${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `Updated ${ageMinutes}m ago`;
  return `Updated ${Math.floor(ageMinutes / 60)}h ago`;
}

export function UsageSyncAge({ updatedAt }: { updatedAt: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), DISPLAY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  return <span className="taskbar-usage-sync-age">{formatSyncAge(updatedAt, now)}</span>;
}
