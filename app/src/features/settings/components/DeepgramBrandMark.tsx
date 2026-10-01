import { cn } from '@/lib/utils';
import type { DeepgramSttOptionId } from '@/lib/deepgram';

interface DeepgramBrandMarkProps {
  className?: string;
  label?: string;
}

export function DeepgramBrandMark({ className, label = 'Deepgram' }: DeepgramBrandMarkProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#071b14] shadow-[inset_0_0_0_1px_rgba(19,239,147,0.3)]',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-[72%] w-[72%]" aria-hidden="true">
        <path
          fill="#13EF93"
          d="M11.203 24H1.517a.364.364 0 0 1-.258-.62l6.239-6.275a.366.366 0 0 1 .259-.108h3.52c2.723 0 5.025-2.127 5.107-4.845a5.004 5.004 0 0 0-4.999-5.148H7.613v4.646c0 .2-.164.364-.365.364H.968a.365.365 0 0 1-.363-.364V.364C.605.164.768 0 .969 0h10.416c6.684 0 12.111 5.485 12.01 12.187C23.293 18.77 17.794 24 11.202 24z"
        />
      </svg>
    </span>
  );
}

const MODEL_MARKS: Readonly<
  Record<DeepgramSttOptionId, { code: string; accent: string; surface: string }>
> = {
  'nova-3-mono': { code: 'N3', accent: '#13EF93', surface: '#071b14' },
  'nova-2-compat': { code: 'N2', accent: '#6ee7b7', surface: '#10251d' },
  'nova-3-multi': { code: 'N3+', accent: '#54d6ff', surface: '#081d29' },
  'flux-en': { code: 'FX', accent: '#c4ff4d', surface: '#172207' },
  'flux-multi': { code: 'FX+', accent: '#c084fc', surface: '#21112d' },
};

export function DeepgramModelMark({ id, label }: { id: DeepgramSttOptionId; label: string }) {
  const mark = MODEL_MARKS[id];
  return (
    <span
      role="img"
      aria-label={`${label} model`}
      data-testid="deepgram-model-mark"
      className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 font-mono text-[10px] font-bold tracking-tight shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={{ color: mark.accent, backgroundColor: mark.surface }}
    >
      <span
        aria-hidden="true"
        className="absolute -right-2 -top-2 h-5 w-5 rounded-full opacity-30 blur-[5px]"
        style={{ backgroundColor: mark.accent }}
      />
      {mark.code}
    </span>
  );
}
