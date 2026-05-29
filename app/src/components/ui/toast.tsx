import * as React from 'react';
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { AnimatePresence, motion } from 'motion/react';
import { Check, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lightweight in-app toast system. Self-contained (no external lib).
 * Use anywhere via `toast.success(...)`, `toast.info(...)` etc.
 */

export type ToastVariant = 'info' | 'success' | 'warning' | 'destructive';

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nanoid(8);
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    if (t.duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, t.duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

function makeToast(variant: ToastVariant) {
  return (title: string, description?: string, duration = 4000) =>
    useToastStore.getState().push({ title, description, variant, duration });
}

export const toast = {
  info: makeToast('info'),
  success: makeToast('success'),
  warning: makeToast('warning'),
  error: makeToast('destructive'),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
  clear: () => useToastStore.getState().clear(),
};

const variantStyles: Record<ToastVariant, { ring: string; icon: React.ReactNode }> = {
  info: { ring: 'border-info/30', icon: <Info className="h-4 w-4 text-info" /> },
  success: { ring: 'border-success/30', icon: <Check className="h-4 w-4 text-success" /> },
  warning: { ring: 'border-warning/30', icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
  destructive: { ring: 'border-destructive/30', icon: <AlertTriangle className="h-4 w-4 text-destructive" /> },
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => {
          const style = variantStyles[t.variant];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 16, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 16, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className={cn(
                'pointer-events-auto rounded-md border bg-elevated shadow-2xl px-3 py-2.5 min-w-[280px] max-w-[420px]',
                'flex items-start gap-2.5',
                style.ring,
              )}
            >
              <div className="mt-0.5">{style.icon}</div>
              <div className="flex-1 min-w-0">
                {t.title && <div className="text-ui-strong text-foreground">{t.title}</div>}
                {t.description && (
                  <div className="text-secondary text-muted-foreground mt-0.5 break-words">{t.description}</div>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="rounded p-0.5 hover:bg-muted transition-colors text-muted-foreground"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
