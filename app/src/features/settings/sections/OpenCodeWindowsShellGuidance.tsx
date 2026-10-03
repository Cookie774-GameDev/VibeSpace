import { useState } from 'react';
import { Button } from '@/components/ui';
import { isTauri, openExternal } from '@/lib/tauri';

const GIT_WINDOWS_INSTRUCTIONS = 'https://git-scm.com/install/windows';

/** Guidance only: shell discovery and provider readiness remain native-owned. */
export function OpenCodeWindowsShellGuidance({
  native = isTauri,
  platform = globalThis.navigator?.platform || globalThis.navigator?.userAgent || '',
  openInstructions = openExternal,
}: {
  native?: boolean;
  platform?: string;
  openInstructions?: (url: string) => Promise<void>;
}) {
  const [openFailed, setOpenFailed] = useState(false);
  if (!native || !/(?:^Win(?:32|64)$|\bWindows\b)/i.test(platform)) return null;

  const showInstructions = async () => {
    setOpenFailed(false);
    try {
      await openInstructions(GIT_WINDOWS_INSTRUCTIONS);
    } catch {
      setOpenFailed(true);
    }
  };

  return (
    <section aria-label="Windows shell tool recovery" className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        If an OpenCode shell tool reports that Bash is unavailable, Git for Windows provides Git
        Bash. Install it using the instructions below, fully close and reopen VibeSpace, then retry
        that tool. This step does not replace provider sign-in.
      </p>
      <p className="text-muted-foreground">
        If you already selected a custom shell, check that its executable still exists before
        retrying.
      </p>
      <Button type="button" size="sm" variant="ghost" onClick={() => void showInstructions()}>
        Open Git for Windows instructions
      </Button>
      {openFailed ? (
        <p role="alert" className="text-muted-foreground">
          Could not open the instructions. Visit {GIT_WINDOWS_INSTRUCTIONS} in your browser.
        </p>
      ) : null}
    </section>
  );
}
