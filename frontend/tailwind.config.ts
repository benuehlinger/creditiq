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
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // The display face is for the wordmark and headings ONLY. Charts, axis
        // labels and every number stay in the system sans: the dataviz rules are
        // explicit that a display face on a hero figure reads as off-brand
        // decoration, and tabular alignment depends on the system metrics.
        display: ['Space Grotesk', ...tokens.type.sans.split(', ')],
        // The brand face, for the CreditIQ wordmark ONLY. A serif anywhere else
        // in this interface would read as a different product.
        brand: ['Tinos', 'Times New Roman', 'Georgia', 'serif'],
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
      // The default border colour, which is also what preflight paints on
      // every element. Tailwind's own default is a light grey that glows on
      // the dark surface, and any border class that fails to resolve falls
      // back to it — which is how 22 row separators rendered near-white in
      // dark mode. With the hairline token as the default, a fallback is
      // invisible instead of glaring.
      borderColor: { DEFAULT: 'var(--chrome-border)' },
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
