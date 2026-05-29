import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // base: small, dense, focus-ringed; transitions short and calm
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-secondary font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
        ghost: 'hover:bg-muted hover:text-foreground text-muted-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border bg-transparent hover:bg-muted text-foreground',
        accent:
          'bg-accent-gradient text-white shadow-[0_0_12px_-2px_hsl(var(--accent-cyan)/0.5)] hover:shadow-[0_0_18px_-2px_hsl(var(--accent-violet)/0.6)] transition-shadow',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-metadata',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8',
        'icon-sm': 'h-6 w-6 [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
