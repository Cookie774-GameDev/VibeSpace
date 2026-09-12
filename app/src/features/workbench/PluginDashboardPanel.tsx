import { ExternalLink, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openExternal } from '@/lib/tauri';
import {
  getPluginManifest,
  PluginLogo,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from '@/features/plugins';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';

const DASHBOARD_URLS: Readonly<Record<string, string>> = {
  github: 'https://github.com',
  supabase: 'https://supabase.com/dashboard',
};

export function PluginDashboardPanel({ pluginId }: { pluginId?: string }) {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const plugin = pluginId ? getPluginManifest(pluginId) : undefined;
  const connection = usePluginStore(
    (state) => selectPluginConnectionsForAccount(state, accountId)[pluginId ?? ''],
  );

  if (!plugin) {
    return (
      <div className="workbench-panel-empty" role="status">
        <PlugZap />
        <strong>Plugin unavailable</strong>
        <span>The saved plugin is no longer installed. Reconnect it from Plugins.</span>
      </div>
    );
  }

  const dashboardUrl = DASHBOARD_URLS[plugin.id] ?? plugin.credentialUrl ?? plugin.docsUrl;
  return (
    <section className="workbench-plugin-dashboard" aria-label={`${plugin.name} dashboard`}>
      <header>
        <PluginLogo plugin={plugin} />
        <div>
          <h3>{plugin.name}</h3>
          <p>{connection?.state === 'connected' ? 'Connected' : 'Connection needs attention'}</p>
        </div>
      </header>
      <p>{plugin.description}</p>
      <dl>
        <div><dt>Terminal access</dt><dd>{connection?.enabled ? 'Enabled' : 'Disabled'}</dd></div>
        <div><dt>Available tools</dt><dd>{plugin.tools.length}</dd></div>
      </dl>
      {dashboardUrl && (
        <Button type="button" size="sm" onClick={() => void openExternal(dashboardUrl)}>
          <ExternalLink /> Open {plugin.name} dashboard
        </Button>
      )}
    </section>
  );
}
