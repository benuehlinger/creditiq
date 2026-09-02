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

/** Mark idea: the monogram. The product's initials knocked out of a plate in
 *  the wordmark's own serif, the way an index provider marks its tools. */
export function MarkMonogram({ size = 28, className = '' }: {
  size?: number; className?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         className={className} role="img" aria-label="CreditIQ">
      <rect width="32" height="32" rx="6" fill="var(--brand-mark-bg)" />
      <text x="16" y="21.5" textAnchor="middle" fill="#FFFFFF"
            style={{ font: `700 15px ${BRAND_FACE.stack}` }}>IQ</text>
    </svg>
  )
}

/** Mark idea: the instrument glyph. No plate — a fitted hazard drawn as a fine
 *  line over three binned ticks, in whatever ink the surface uses. Reads as an
 *  instrument rather than an app icon, and disappears politely at small sizes. */
export function MarkCurve({ size = 28, className = '' }: {
  size?: number; className?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         className={className} role="img" aria-label="CreditIQ">
      <path d="M4 27h5M13.5 27h5M23 27h5" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" opacity="0.4" />
      <path d="M4 22.5 C 10 21, 14 15, 18.5 10.5 S 25 4.6, 28 4.2"
            stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" fill="none" />
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

/** CreditIQ, set in the display face. One colour, one weight.
 *
 *  The earlier treatment coloured the IQ in accent blue. A two-tone name is
 *  the reliable tell of a small-shop product: the established references —
 *  Capital IQ, Aladdin, the KPMG mark itself — set the name in a single
 *  colour and let the type carry it. Contrast against KPMG comes from the
 *  serif face, not from paint. */
export function CreditIQWordmark({ size = 17, className = '' }: {
  size?: number; className?: string
}) {
  // The face, weight and size all come from BRAND_FACE so that changing it is
  // one edit rather than a hunt through call sites.
  return (
    <span className={`leading-none ${className}`}
          style={{ fontFamily: BRAND_FACE.stack, fontWeight: BRAND_FACE.weight,
                   fontSize: size, letterSpacing: '-0.015em',
                   color: 'var(--brand-name)' }}>
      CreditIQ
    </span>
  )
}

/** The descriptor: what the product is, in five words, set the way an
 *  instrument panel labels itself — tracked capitals, quiet, under the name.
 *  This line is most of the difference between a name floating in a header
 *  and a product that states its business. */
export function BrandDescriptor({ size = 8, className = '' }: {
  size?: number; className?: string
}) {
  return (
    <span className={`block font-sans font-medium uppercase text-ink-muted ${className}`}
          style={{ fontSize: size, letterSpacing: '0.18em', lineHeight: 1 }}>
      Credit Risk Model Development
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
    <div className={className}>
      <CreditIQWordmark size={44} />
      <BrandDescriptor size={11} className="mt-3" />
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
/** The lockup structures under consideration. Each is one answer to the same
 *  question: how much room does the firm take next to the product? They differ
 *  in HIERARCHY, which is the only axis worth having options on. */
export type CoBrandVariant = 'rule' | 'space' | 'inline' | 'endorse' | 'tile'

export const BRAND_DIRECTIONS: { key: CoBrandVariant; label: string; note: string }[] = [
  { key: 'rule', label: 'Rule', note: 'Equal partners divided by a hairline. The conventional consulting lockup: the firm attributes, the product states its business beneath its name.' },
  { key: 'space', label: 'Space', note: 'The same balance with the divider removed. Space does the separating; reads a shade more modern and a shade less institutional.' },
  { key: 'inline', label: 'Inline', note: 'One line: the descriptor runs beside the name instead of beneath it. The most compact, at the cost of the descriptor reading as a suffix rather than a statement.' },
  { key: 'endorse', label: 'Endorsement', note: 'The product leads and the firm signs it, the way a built product is usually credited. Strongest product identity; KPMG smallest.' },
  { key: 'tile', label: 'Mark', note: 'The product carries a graphic mark before its name. The earlier decision was that two graphics compete; on the table again for the comparison.' },
]

/** The two marks together, in the chosen structure. `scale` drives everything
 *  from one number so the pieces cannot drift apart. */
export function CoBrand({ scale = 1, variant = 'rule', className = '' }: {
  scale?: number; variant?: CoBrandVariant; className?: string
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
  const nameBlock = (
    <span className="flex flex-col" style={{ gap: 4 * scale }}>
      <CreditIQWordmark size={brandSizeForCap(cap * 0.86)} />
      <BrandDescriptor size={7.5 * scale} />
    </span>
  )

  if (variant === 'space') {
    return (
      <span className={`inline-flex items-center ${className}`} style={{ gap: 26 * scale }}>
        <KpmgMark height={cap} />
        {nameBlock}
      </span>
    )
  }
  if (variant === 'inline') {
    return (
      <span className={`inline-flex items-center ${className}`} style={{ gap: 16 * scale }}>
        <KpmgMark height={cap} />
        <span style={{ width: 1, height: 20 * scale, background: 'var(--chrome-border)' }} />
        <CreditIQWordmark size={brandSizeForCap(cap * 0.86)} />
        <BrandDescriptor size={7.5 * scale} className="!inline" />
      </span>
    )
  }
  if (variant === 'endorse') {
    return (
      <span className={`inline-flex flex-col ${className}`} style={{ gap: 4 * scale }}>
        <CreditIQWordmark size={brandSizeForCap(cap * 0.95)} />
        <span className="flex items-center" style={{ gap: 8 * scale }}>
          <BrandDescriptor size={7.5 * scale} />
          <span className="font-sans font-medium uppercase text-ink-muted"
                style={{ fontSize: 7.5 * scale, letterSpacing: '0.18em', lineHeight: 1 }}>
            · by
          </span>
          <KpmgMark height={9 * scale} />
        </span>
      </span>
    )
  }
  if (variant === 'tile') {
    return (
      <span className={`inline-flex items-center ${className}`} style={{ gap: 12 * scale }}>
        <CreditIQMark size={32 * scale} />
        {nameBlock}
        <span style={{ width: 1, height: 26 * scale, background: 'var(--chrome-border)',
                       marginLeft: 6 * scale }} />
        <KpmgMark height={cap * 0.82} />
      </span>
    )
  }
  // 'rule' — the adopted default
  return (
    <span className={`inline-flex items-center ${className}`}
          style={{ gap: 16 * scale }}>
      <KpmgMark height={cap} />
      <span style={{ width: 1, height: 26 * scale,
                     background: 'var(--chrome-border)' }} />
      {/* No product mark here. Two graphic marks either side of a rule read as
          two logos competing rather than as one attribution and one product
          name; the wordmark alone sits against KPMG as an equal. The name
          carries a descriptor beneath it: the name says what it is called, the
          line under it says what it does. */}
      {nameBlock}
    </span>
  )
}
