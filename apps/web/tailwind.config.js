/**
 * Tailwind config for @sheer/web.
 *
 * Colours are exposed as **semantic tokens** that mirror the `webTheme` in
 * `@sheer/design-tokens`. Always reach for these instead of raw hex values
 * inside screens.
 *
 *   bg / bg-surface / bg-surface-alt / bg-surface-ink / bg-surface-ink-deep
 *   text-text-primary / text-text-secondary / text-text-muted / text-text-subtle
 *   border-border / border-border-strong / border-border-divider
 *   bg-primary / bg-primary-soft / bg-primary-deep / bg-primary-deepest
 *   bg-success / bg-success-soft / bg-success-fill   (same shape: warning, danger)
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F5F0EA',

        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#FFFCF8',
          ink: '#2B1927',
          'ink-deep': '#20131D',
        },

        primary: {
          DEFAULT: '#6B3A57',
          soft: '#F8EEE9',
          deep: '#4E263E',
          deepest: '#2B1927',
          on: '#FFFFFF',
        },

        accent: {
          DEFAULT: '#D97863',
          soft: '#F2DDD5',
          deep: '#A9515C',
        },

        text: {
          primary: '#2B1927',
          secondary: '#6D6066',
          muted: '#8A7C82',
          subtle: '#A7989E',
          'on-primary': '#FFFFFF',
        },

        border: {
          DEFAULT: '#E4D9CF',
          strong: '#CDBEB3',
          divider: '#F0E8E1',
        },

        success: {
          DEFAULT: '#16A34A',
          soft: 'rgba(74,222,128,0.12)',
          fill: '#4ADE80',
          border: 'rgba(22,163,74,0.32)',
        },
        warning: {
          DEFAULT: '#B45309',
          soft: 'rgba(245,158,11,0.12)',
          fill: '#F59E0B',
          border: 'rgba(180,83,9,0.32)',
        },
        danger: {
          DEFAULT: '#DC2626',
          soft: 'rgba(248,113,113,0.12)',
          fill: '#F87171',
          border: 'rgba(220,38,38,0.32)',
          tint: '#FEF9F9',
        },
      },

      borderRadius: {
        input: '11px',
        'input-lg': '14px',
        card: '18px',
        'card-lg': '22px',
        pill: '9999px',
      },

      fontFamily: {
        sans: ['Aptos', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },

      fontWeight: {
        normal: '400',
        medium: '500',
      },

      boxShadow: {
        card: '0 1px 2px rgba(43,25,39,0.04), 0 5px 16px rgba(43,25,39,0.055)',
        hero: '0 8px 24px rgba(43,25,39,0.08), 0 18px 50px rgba(43,25,39,0.06)',
        modal: '0 18px 45px rgba(43,25,39,0.16), 0 32px 90px rgba(43,25,39,0.14)',
      },
    },
  },
  plugins: [],
};
