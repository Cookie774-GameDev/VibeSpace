import { describe, expect, it, vi } from 'vitest';

import type { QuickLink } from '@/types/quick-link';
import { launchLink } from './launch';

vi.mock('@/lib/db', () => ({
  quickLinkRepo: {
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
  },
}));

function quickLink(url: string): QuickLink {
  return {
    id: 'quick-link-test' as QuickLink['id'],
    workspace_id: 'workspace-test' as QuickLink['workspace_id'],
    label: 'Unknown action',
    url,
    kind: 'jarvis-action',
    behavior: 'side_panel',
    position: 1,
    tags: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('Quick Launch action dispatch', () => {
  it('keeps the launcher open when no feature handles a custom Jarvis action', async () => {
    await expect(launchLink(quickLink('jarvis://missing-feature'))).resolves.toEqual({
      ok: false,
      reason: 'No VibeSpace feature handled this action.',
    });
  });

  it('reports success when a feature acknowledges a custom Jarvis action', async () => {
    const acknowledge = (event: Event) => event.preventDefault();
    window.addEventListener('jarvis:link-action', acknowledge);
    try {
      await expect(launchLink(quickLink('jarvis://installed-feature'))).resolves.toEqual({
        ok: true,
      });
    } finally {
      window.removeEventListener('jarvis:link-action', acknowledge);
    }
  });
});
