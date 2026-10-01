import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('App recovery callback integration', () => {
  it('consumes and scrubs recovery callbacks before rendering ordinary app content', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    const appSource = source.slice(source.indexOf('export function App()'));
    const callbackConsumptionIndex = appSource.indexOf(
      'consumeRecoveryCallbackOnce(window, supabase?.auth ?? null)',
    );
    const runtimeResolutionIndex = appSource.indexOf('const plan = resolveRuntimePlan()');
    const recoveryHostIndex = appSource.indexOf('<RecoveryCallbackHost');
    const appContentIndex = appSource.indexOf('<AppContent plan={plan} />');

    expect(callbackConsumptionIndex).toBeGreaterThan(-1);
    expect(runtimeResolutionIndex).toBeGreaterThan(callbackConsumptionIndex);
    expect(recoveryHostIndex).toBeGreaterThan(-1);
    expect(appContentIndex).toBeGreaterThan(recoveryHostIndex);
    expect(source).toContain(
      'abandonRecoverySessionOwnership(client.auth, result.ownership)',
    );
    expect(source).toContain('else result.ownership.release()');
    expect(source).not.toContain('detectSessionInUrl: true');
  });
});
