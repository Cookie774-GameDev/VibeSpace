import { useUIStore } from '@/stores/ui';
export function CaoIdleScreenSetting() {
  const scene = useUIStore((state) => state.ambientScene);
  const setScene = useUIStore((state) => state.setAmbientScene);
  return (
    <section className="max-w-lg space-y-2">
      <label className="text-sm font-medium" htmlFor="idle-screen-scene">
        Idle screen
      </label>
      <select
        id="idle-screen-scene"
        className="block w-full rounded-md border border-border bg-background p-2 text-sm"
        value={scene}
        onChange={(event) => setScene(event.target.value === 'cao' ? 'cao' : 'clock')}
      >
        <option value="clock">Clock &amp; atmosphere</option>
        <option value="cao">Jarvis CAO · live team desk</option>
      </select>
      <p className="text-xs text-muted-foreground">
        Uses your idle timer (five minutes by default). CAO shows an active mission in this
        workspace; otherwise the clock appears. Drag to look around, Shift-drag to pan, and click a
        desk for details.
      </p>
    </section>
  );
}
