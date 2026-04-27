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
        bg: '#F0EEF6',

        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#F8F6FD',
          ink: '#1C1628',
          'ink-deep': '#18141F',
        },

        primary: {
          DEFAULT: '#A67CF5',
          soft: '#F5F3FF',
          deep: '#7C3AED',
          deepest: '#2E1F4A',
          on: '#FFFFFF',
        },

        text: {
          primary: '#1C1628',
          secondary: '#6B6480',
          muted: '#999999',
          subtle: '#AAAAAA',
          'on-primary': '#FFFFFF',
        },

        border: {
          DEFAULT: '#EAE8F0',
          strong: '#D0CCE0',
          divider: '#F0EDF8',
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
        input: '10px',
        'input-lg': '12px',
        card: '14px',
        'card-lg': '16px',
        pill: '20px',
      },

      fontFamily: {
        sans: ['Arial', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },

      fontWeight: {
        normal: '400',
        medium: '500',
      },

      boxShadow: {
        card: '0 1px 2px rgba(28,22,40,0.04), 0 2px 6px rgba(28,22,40,0.06)',
        hero: '0 4px 12px rgba(28,22,40,0.08), 0 8px 24px rgba(28,22,40,0.06)',
        modal: '0 10px 25px rgba(28,22,40,0.12), 0 20px 60px rgba(28,22,40,0.16)',
      },
    },
  },
  plugins: [],
};
