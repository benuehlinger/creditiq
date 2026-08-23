/** Tailwind reads the design tokens rather than restating them, so the palette
 *  has exactly one source of truth and cannot drift from the validated file. */
import tokens from './src/design/tokens.json' assert { type: 'json' }

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Everything resolves through CSS custom properties so light and dark
        // swap in one place. See src/design/theme.css.
        surface: 'var(--surface-chart)',
        page: 'var(--surface-page)',
        raised: 'var(--surface-raised)',
        sunken: 'var(--surface-sunken)',
        ink: {
          DEFAULT: 'var(--ink-primary)',
          secondary: 'var(--ink-secondary)',
          muted: 'var(--ink-muted)',
          inverse: 'var(--ink-inverse)',
        },
        grid: 'var(--chrome-grid)',
        axis: 'var(--chrome-axis)',
        hairline: 'var(--chrome-border)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        s1: 'var(--series-1)', s2: 'var(--series-2)', s3: 'var(--series-3)',
        s4: 'var(--series-4)', s5: 'var(--series-5)',
        good: tokens.status.good,
        warning: tokens.status.warning,
        serious: tokens.status.serious,
        critical: tokens.status.critical,
        deemph: 'var(--deemphasis)',
      },
      fontFamily: {
        sans: tokens.type.sans.split(', '),
        mono: tokens.type.mono.split(', '),
        // The display face is for the wordmark and headings ONLY. Charts, axis
        // labels and every number stay in the system sans: the dataviz rules are
        // explicit that a display face on a hero figure reads as off-brand
        // decoration, and tabular alignment depends on the system metrics.
        display: ['Space Grotesk', ...tokens.type.sans.split(', ')],
      },
      fontSize: {
        micro: ['10px', { lineHeight: '14px', letterSpacing: '0.04em' }],
        tiny: ['11px', { lineHeight: '15px' }],
        xs: ['12px', { lineHeight: '17px' }],
        sm: ['13px', { lineHeight: '19px' }],
        base: ['14px', { lineHeight: '21px' }],
        lg: ['16px', { lineHeight: '23px' }],
        xl: ['19px', { lineHeight: '26px' }],
        '2xl': ['24px', { lineHeight: '30px' }],
        '3xl': ['32px', { lineHeight: '38px' }],
        hero: ['52px', { lineHeight: '56px', letterSpacing: '-0.02em' }],
      },
      borderRadius: { card: '10px', ctl: '7px' },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.06), 0 0 0 1px var(--chrome-border)',
        pop: '0 8px 28px rgba(0,0,0,0.28), 0 0 0 1px var(--chrome-border)',
      },
      transitionTimingFunction: { causal: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    },
  },
  plugins: [],
}
