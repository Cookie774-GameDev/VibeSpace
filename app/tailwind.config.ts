import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        // Voltage design system - all values reference CSS variables in globals.css
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        panel: 'hsl(var(--panel))',
        elevated: 'hsl(var(--elevated))',

        border: {
          DEFAULT: 'hsl(var(--border))',
          mid: 'hsl(var(--border-mid))',
        },
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',

        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
          // Names kept for back-compat with V1 components.
          // V2 cozy theme: cyan -> copper, violet -> amber.
          cyan: 'hsl(var(--accent-cyan))',
          violet: 'hsl(var(--accent-violet))',
          // V2 semantic aliases — new code should use these.
          copper: 'hsl(var(--accent-copper))',
          amber: 'hsl(var(--accent-amber))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },

        // Status colors
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        info: 'hsl(var(--info))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Voltage type scale (designed for density)
        metadata: ['11px', { lineHeight: '14px', letterSpacing: '0.01em' }],
        secondary: ['12px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '20px' }],
        'ui-strong': ['14px', { lineHeight: '20px', fontWeight: '500' }],
        'page-title': ['18px', { lineHeight: '24px', fontWeight: '600' }],
        hero: ['28px', { lineHeight: '36px', fontWeight: '600' }],
      },
      keyframes: {
        // Soft breathing for the voice orb idle state
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.04)', opacity: '1' },
        },
        // Apple-Intelligence-style rotating conic glow
        'glow-rotate': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        // Beam shimmer for council mode
        'beam-flow': {
          '0%': { 'stroke-dashoffset': '40' },
          '100%': { 'stroke-dashoffset': '0' },
        },
        // Subtle aurora for hero areas
        aurora: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)', opacity: '0.6' },
          '50%': { transform: 'translate(2%, -2%) scale(1.08)', opacity: '0.85' },
        },
        // Skeleton shimmer
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        // Slide / fade for popovers and modals
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-out': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'scale-in': {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        breathe: 'breathe 4s ease-in-out infinite',
        'glow-rotate': 'glow-rotate 8s linear infinite',
        'beam-flow': 'beam-flow 2.5s linear infinite',
        aurora: 'aurora 12s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
        'fade-in': 'fade-in 150ms ease-out',
        'fade-out': 'fade-out 150ms ease-in',
        'slide-up': 'slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
      backgroundImage: {
        // V2 cozy gradient: copper -> amber. CSS variable values shifted in
        // globals.css so this gradient now reads warm. The class name kept
        // intentionally so existing components don't have to change.
        'accent-gradient': 'linear-gradient(135deg, hsl(var(--accent-cyan)) 0%, hsl(var(--accent-violet)) 100%)',
        'aurora-gradient':
          'radial-gradient(ellipse 80% 50% at 50% 0%, hsl(var(--accent-cyan) / 0.15), transparent 70%), radial-gradient(ellipse 80% 50% at 80% 100%, hsl(var(--accent-violet) / 0.12), transparent 70%)',
        // V2 cozy paper texture for ambient + onboarding hero.
        'paper-warm':
          'radial-gradient(ellipse 90% 60% at 50% 0%, hsl(var(--accent-amber) / 0.08), transparent 60%), radial-gradient(ellipse 70% 50% at 30% 100%, hsl(var(--accent-copper) / 0.06), transparent 70%)',
      },
    },
  },
  plugins: [],
};

export default config;
