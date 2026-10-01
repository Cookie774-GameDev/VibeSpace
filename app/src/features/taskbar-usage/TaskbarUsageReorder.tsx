import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw, X } from 'lucide-react';
import type { TaskbarUsageStoreSnapshot } from './taskbarUsageStore';

export function TaskbarUsageReorder({
  state,
  onMove,
  onMoveTo,
  onToggleHidden,
  onReset,
  onClose,
}: {
  state: TaskbarUsageStoreSnapshot;
  onMove(providerId: string, direction: -1 | 1): void;
  onMoveTo(providerId: string, targetIndex: number): void;
  onToggleHidden(providerId: string, hidden: boolean): void;
  onReset(): void;
  onClose(): void;
}) {
  const order = new Map(state.preferences.providerOrder.map((id, index) => [id, index]));
  const hidden = new Set(state.preferences.hiddenProviderIds);
  const providers = [...state.payload.snapshots].sort((left, right) => {
    return (
      (order.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.providerId) ?? Number.MAX_SAFE_INTEGER) ||
      left.displayName.localeCompare(right.displayName)
    );
  });
  return (
    <section className="taskbar-usage-reorder" aria-label="Provider order">
      <header>
        <strong>Provider order</strong>
        <button type="button" onClick={onReset} aria-label="Restore default provider order">
          <RotateCcw aria-hidden="true" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close provider order">
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="taskbar-usage-reorder-list">
        {providers.map((provider, index) => {
          const isHidden = hidden.has(provider.providerId);
          return (
            <div
              key={provider.providerId}
              className="taskbar-usage-reorder-row"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-vibespace-provider', provider.providerId);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const dragged = event.dataTransfer.getData('application/x-vibespace-provider');
                if (providers.some(({ providerId }) => providerId === dragged)) {
                  onMoveTo(dragged, index);
                }
              }}
            >
              <span>{provider.displayName}</span>
              {!isHidden && index < 4 && <em>Shown</em>}
              <button
                type="button"
                onClick={() => onMove(provider.providerId, -1)}
                disabled={index === 0}
                aria-label={`Move ${provider.displayName} earlier`}
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onMove(provider.providerId, 1)}
                disabled={index === providers.length - 1}
                aria-label={`Move ${provider.displayName} later`}
              >
                <ArrowDown aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onToggleHidden(provider.providerId, !isHidden)}
                aria-label={`${isHidden ? 'Show' : 'Hide'} ${provider.displayName}`}
              >
                {isHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
