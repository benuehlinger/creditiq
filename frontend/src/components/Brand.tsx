import { useEffect, useState } from 'react'

/**
 * Brand marks.
 *
 * Two lockups, deliberately separate. The KPMG wordmark identifies WHO built the
 * thing; the CreditIQ mark identifies WHAT it is. Fusing them into one graphic
 * would be inventing a co-brand nobody approved.
 *
 * The KPMG file is loaded at runtime rather than inlined, so replacing it with
 * the asset from the internal brand portal is a file copy and nothing else
 * changes. The SVG carries no fill attribute, so it takes `currentColor`.
 */

/** The product mark: three ascending bars under a hazard curve.
 *
 *  Not decoration — it is the two things this product actually does. The bars
 *  are a binning; the curve through them is a fitted hazard. It reads at 20px in
 *  a header and at 96px on a title slide, which is the only real test of a mark.
 */
export function CreditIQMark({ size = 28, className = '' }: {
  size?: number; className?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         className={className} role="img" aria-label="CreditIQ">
      <rect width="32" height="32" rx="7.5" fill="var(--brand-mark-bg)" />
      {/* the binning: three ascending bars, 2px surface gaps, rounded data ends */}
      <rect x="7"  y="18" width="4" height="7"  rx="1.4" fill="var(--brand-mark-bar)" />
      <rect x="14" y="14" width="4" height="11" rx="1.4" fill="var(--brand-mark-bar)" />
      <rect x="21" y="9"  width="4" height="16" rx="1.4" fill="var(--brand-mark-bar)" />
      {/* the fitted hazard running through them */}
      <path d="M6 21.5 C 11 20, 14 15.5, 18 11.5 S 23 6.4, 26.5 6"
            stroke="var(--brand-mark-curve)" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="26.5" cy="6" r="2.1" fill="var(--brand-mark-curve)" />
    </svg>
  )
}

/**
 * The adopted wordmark face.
 *
 * One entry from `WORDMARK_CANDIDATES` at the foot of this file, which is also
 * what the brand page renders side by side against the real KPMG mark. Changing
 * the face is this line plus the matching `@import` in `design/theme.css`.
 *
 * `cap` is the cap height as a fraction of the em, MEASURED off a rendered
 * glyph rather than taken from a specimen. It matters because the lockups size
 * by cap height, not by font size: two faces at the same point size print
 * visibly different letters, and the previous face was 15 per cent smaller than
 * the one before it at an identical setting.
 */
export const BRAND_FACE = {
  stack: "'Merriweather', Georgia, 'Times New Roman', serif",
  weight: 700,
  // Measured, not taken from a specimen: the published figure for Merriweather
  // is 0.72em, and scanning a rendered capital gives 0.76. Trusting the
  // published number printed caps 1.2px taller than the KPMG letters.
  cap: 0.76,
} as const

export const BRAND_CAP_RATIO = BRAND_FACE.cap

/** The font size that renders caps of a given height. */
export const brandSizeForCap = (cap: number) => cap / BRAND_CAP_RATIO

/** CreditIQ, set in the display face. `IQ` carries the accent so the name reads
 *  as one word with a point of emphasis rather than two words jammed together. */
export function CreditIQWordmark({ size = 17, className = '' }: {
  size?: number; className?: string
}) {
  // The face, weight and size all come from BRAND_FACE so that changing it is
  // one edit rather than a hunt through call sites.
  return (
    <span className="leading-none"
          style={{ fontFamily: BRAND_FACE.stack, fontWeight: BRAND_FACE.weight,
                   fontSize: size }}>
      <span className={className} style={{ color: 'var(--brand-name)' }}>Credit</span>
      <span style={{ color: 'var(--brand-name-accent)' }}>IQ</span>
    </span>
  )
}

export function CreditIQLockup({ size = 28, nameSize = 17, className = '' }: {
  size?: number; nameSize?: number; className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <CreditIQMark size={size} />
      <CreditIQWordmark size={nameSize} />
    </span>
  )
}

/**
 * The KPMG wordmark.
 *
 * Fetched from `/brand/kpmg.svg` and inlined so it can be tinted — an `<img>`
 * cannot take `currentColor`, and this has to sit on both a light and a dark
 * surface. If the file is missing the component falls back to plain type rather
 * than a broken-image icon, because a demo that shows a broken asset in the
 * header is worse than one that shows a word.
 *
 * SIZING. The four squares occupy the upper half of the artwork and the letters
 * only the lower 55%, so sizing by the bounding box makes the type far smaller
 * than it looks like it should be — a 21px mark has 11px letters. `height` here
 * therefore means the height of the LETTERS, and the component scales the box up
 * to suit. That is what makes it balance against a wordmark set beside it.
 */

/** The letters occupy the lower 55% of the artwork; measured from the path. */
const KPMG_LETTER_RATIO = 0.55

/**
 * Strip baked-in colour so the mark can take `currentColor`.
 *
 * The file has no `fill` ATTRIBUTE, which is what I checked first and why I
 * wrongly concluded it was already tintable. The colour is in an inline STYLE on
 * the path — `style="fill:#003087;stroke:#ffffff;..."` — and an inline style beats
 * a fill inherited from the parent `<svg>`. So the mark stayed KPMG blue on the
 * dark surface no matter what the CSS variable said.
 *
 * Only paint declarations are removed. Geometry-bearing ones — stroke-width,
 * stroke-linejoin and the rest — are left alone, because dropping those changes
 * the shape of a trademark rather than its colour.
 */
function tintable(svg: string): string {
  const PAINT = /(^|;)\s*(fill|stroke|fill-opacity|stroke-opacity)\s*:[^;"]*/gi
  return svg
    .replace(/style="([^"]*)"/gi, (_m, decls: string) => {
      const kept = decls.replace(PAINT, '').replace(/^;+|;+$/g, '').replace(/;{2,}/g, ';')
      return kept ? `style="${kept}"` : ''
    })
    .replace(/\s(fill|stroke)="(?!none)[^"]*"/gi, '')
}
export function KpmgMark({ height = 21, className = '' }: {
  /** Height of the LETTERS, not of the bounding box. */
  height?: number
  className?: string
}) {
  const boxHeight = height / KPMG_LETTER_RATIO
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/brand/kpmg.svg')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (live && t.trim().startsWith('<svg')) setSvg(tintable(t)) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  if (failed || !svg) {
    return (
      <span className={`font-display font-bold leading-none tracking-tight ${className}`}
            style={{ fontSize: height, color: 'var(--brand-kpmg)' }}>
        KPMG
      </span>
    )
  }
  return (
    <span
      className={`inline-block ${className}`}
      style={{ height: boxHeight, color: 'var(--brand-kpmg)' }}
      aria-label="KPMG"
      role="img"
      // a static asset we ship, validated as an <svg> before insertion
      dangerouslySetInnerHTML={{
        __html: svg.replace(
          '<svg',
          `<svg style="height:${boxHeight}px;width:auto;display:block;fill:currentColor"`,
        ),
      }}
    />
  )
}

/** The hero lockup, for a title slide or an empty state. Bigger, with the
 *  descriptor set quietly underneath so the mark is not competing with it. */
export function CreditIQHero({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <CreditIQMark size={64} />
      <div>
        <CreditIQWordmark size={40} />
        <div className="mt-1.5 text-xs tracking-wide text-ink-muted">
          Credit risk model development
        </div>
      </div>
    </div>
  )
}

/**
 * The two marks together, optically balanced.
 *
 * `scale` drives both from one number so they cannot drift apart: the KPMG
 * letters and the CreditIQ wordmark are set to the same cap height, and the
 * CreditIQ tile is sized to sit between them.
 */
/**
 * The adopted co-brand lockup — the RULE treatment.
 *
 * KPMG and CreditIQ as equal partners with a rule between them. The
 * alternatives are on the brand page and render from the same component, so a
 * preview there cannot drift from what the header shows.
 */
export function CoBrand({ scale = 1, className = '' }: {
  scale?: number; className?: string
}) {
  // The KPMG wordmark sets the scale, because it is the fixed quantity — it is
  // someone else's artwork and cannot be redrawn to fit. Everything else is
  // measured off its cap height.
  const cap = 22 * scale
  // Centred on the KPMG mark AS A WHOLE, squares included — not on its letter
  // baseline. Baseline alignment put CreditIQ level with the letters, which sit
  // in the lower 55% of the artwork, so the name hung off the bottom of a mark
  // half a head taller than it.
  //
  // `items-center` is enough to centre the CAPS rather than the box: at
  // `leading-none` Merriweather's cap band is centred on its own line box to
  // within half a percent, so the two coincide. The descender on the Q is
  // deliberately not counted — optical centring reads off the cap band.
  return (
    <span className={`inline-flex items-center ${className}`}
          style={{ gap: 16 * scale }}>
      <KpmgMark height={cap} />
      <span style={{ width: 1, height: 20 * scale,
                     background: 'var(--chrome-border-strong)' }} />
      {/* No product mark here. Two graphic marks either side of a rule read as
          two logos competing rather than as one attribution and one product
          name; the wordmark alone sits against KPMG as an equal. The mark still
          exists for the favicon and the title slide, where it stands alone. */}
      <CreditIQWordmark size={brandSizeForCap(cap)} />
    </span>
  )
}


/**
 * Co-brand variants.
 *
 * One decision, four ways of making it: how much room the firm takes next to the
 * product. They differ in HIERARCHY, not in decoration — which is the only thing
 * worth having options about.
 *
 * All four are driven from the KPMG cap height, because that artwork is the fixed
 * quantity: it belongs to someone else and cannot be redrawn to fit.
 */
export type CoBrandVariant = 'rule' | 'space' | 'endorse' | 'stack'

export const CO_BRAND_VARIANTS: { key: CoBrandVariant; label: string; note: string }[] = [
  { key: 'rule', label: 'Rule', note: 'Equal partners, divided. The conventional consulting lockup.' },
  { key: 'space', label: 'Space', note: 'The same balance with the divider removed — space does the separating.' },
  { key: 'endorse', label: 'Endorsement', note: 'The product leads and the firm endorses it. How a built product is usually signed.' },
  { key: 'stack', label: 'Stacked', note: 'For a narrow column or a title slide, where width is the scarce thing.' },
]

export function CoBrandVariantMark({ variant, scale = 1, className = '' }: {
  variant: CoBrandVariant; scale?: number; className?: string
}) {
  const cap = 22 * scale

  if (variant === 'space') {
    // A rule is a stated boundary; space is an implied one, and at this size the
    // implication is enough. The gap is wider than the rule version's because a
    // divider lets two things sit closer than they otherwise could.
    return (
      <span className={`inline-flex items-center ${className}`} style={{ gap: 30 * scale }}>
        <KpmgMark height={cap} />
        <CreditIQWordmark size={brandSizeForCap(cap * 1.02)} />
      </span>
    )
  }

  if (variant === 'endorse') {
    // The product is the subject and the firm is the signature, so the firm sets
    // in the smaller size. `from` is deliberately lowercase and quiet — it is
    // grammar, not a word anyone should read twice.
    return (
      <span className={`inline-flex items-baseline ${className}`} style={{ gap: 14 * scale }}>
        <CreditIQWordmark size={brandSizeForCap(cap * 1.28)} />
        <span className="inline-flex items-baseline" style={{ gap: 7 * scale }}>
          <span className="text-ink-muted" style={{ fontSize: 11 * scale }}>from</span>
          <KpmgMark height={cap * 0.72} />
        </span>
      </span>
    )
  }

  if (variant === 'stack') {
    // Width is the scarce dimension here, so the firm goes above as an
    // endorsement line and the product takes the full measure below.
    return (
      <span className={`inline-flex flex-col ${className}`} style={{ gap: 7 * scale }}>
        <KpmgMark height={cap * 0.68} />
        <CreditIQWordmark size={brandSizeForCap(cap * 1.22)} />
      </span>
    )
  }

  return <CoBrand scale={scale} className={className} />
}


/**
 * Candidate wordmark faces.
 *
 * A specimen sheet is the wrong place to choose a wordmark: what matters is how
 * the name sits against the KPMG mark at header size, and that is a relationship
 * rather than a property of the face. Each candidate is therefore rendered in
 * the real lockup, at a cap height matched to the KPMG letters, so the
 * comparison is like for like — a face with a small cap height is not penalised
 * for looking smaller at the same font size, which is exactly the trap the last
 * change fell into.
 *
 * `cap` is the measured cap height as a fraction of the em, taken off a rendered
 * glyph. See `measureCapRatio` on the brand page.
 */
export const WORDMARK_CANDIDATES = [
  { key: 'merriweather', label: 'Merriweather Bold', stack: "'Merriweather', serif",
    weight: 700, cap: 0.76, note: 'Adopted. A sturdy text serif — large x-height, low contrast, holds up small.' },
  { key: 'tinos', label: 'Tinos Bold', stack: "'Tinos', serif",
    weight: 700, cap: 0.67, note: 'Times metrics. Narrower and more formal.' },
  { key: 'inter', label: 'Inter SemiBold', stack: "'Inter', sans-serif",
    weight: 600, cap: 0.727, note: 'The neutral modern grotesque. Reads as software.' },
  { key: 'manrope', label: 'Manrope SemiBold', stack: "'Manrope', sans-serif",
    weight: 600, cap: 0.715, note: 'Geometric with squared terminals. More character than Inter, still quiet.' },
  { key: 'dmsans', label: 'DM Sans Medium', stack: "'DM Sans', sans-serif",
    weight: 500, cap: 0.7, note: 'Geometric and low-contrast. Friendly rather than corporate.' },
  { key: 'instrument', label: 'Instrument Sans', stack: "'Instrument Sans Variable', sans-serif",
    weight: 600, cap: 0.72, note: 'Tight, technical, slightly condensed. Built for interfaces.' },
  { key: 'lora', label: 'Lora SemiBold', stack: "'Lora', serif",
    weight: 600, cap: 0.72, note: 'A serif with brushed contrast. Warmer than Tinos, less formal.' },
  { key: 'fraunces', label: 'Fraunces SemiBold', stack: "'Fraunces', serif",
    weight: 600, cap: 0.73, note: 'High-contrast display serif. The most distinctive, the least neutral.' },
] as const

export function CandidateLockup({ stack, weight, cap: capRatio, scale = 1 }: {
  stack: string; weight: number; cap: number; scale?: number
}) {
  const cap = 22 * scale
  return (
    <span className="inline-flex items-center" style={{ gap: 16 * scale }}>
      <KpmgMark height={cap} />
      <span style={{ width: 1, height: 20 * scale, background: 'var(--chrome-border-strong)' }} />
      <span className="leading-none"
            style={{ fontFamily: stack, fontWeight: weight, fontSize: cap / capRatio }}>
        <span style={{ color: 'var(--brand-name)' }}>Credit</span>
        <span style={{ color: 'var(--brand-name-accent)' }}>IQ</span>
      </span>
    </span>
  )
}
