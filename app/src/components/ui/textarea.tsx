import * as React from 'react';
import { cn } from '@/lib/utils';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground resize-none',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-accent-cyan/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'transition-colors',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
