import { Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFullscreenStore } from './fullscreenStore';

export function FocusModeExit() {
  const active = useFullscreenStore((state) => state.focusActive);
  const setFocusActive = useFullscreenStore((state) => state.setFocusActive);

  if (!active) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      aria-label="Exit Focus Mode"
      title="Exit Focus Mode"
      data-focus-mode-exit="true"
      onClick={() => setFocusActive(false)}
      className="fixed right-3 top-3 z-[70] h-9 w-9 border border-border/80 bg-panel/95 shadow-lg backdrop-blur-sm"
    >
      <Minimize2 aria-hidden="true" className="h-4 w-4" />
    </Button>
  );
}
