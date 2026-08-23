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

/** CreditIQ, set in the display face. `IQ` carries the accent so the name reads
 *  as one word with a point of emphasis rather than two words jammed together. */
export function CreditIQWordmark({ size = 17, className = '' }: {
  size?: number; className?: string
}) {
  return (
    <span className={`font-display font-bold leading-none tracking-tight ${className}`}
          style={{ fontSize: size }}>
      <span style={{ color: 'var(--brand-name)' }}>Credit</span>
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
export function CoBrand({ scale = 1, className = '' }: {
  scale?: number; className?: string
}) {
  const cap = 22 * scale
  return (
    <span className={`inline-flex items-center ${className}`}
          style={{ gap: 16 * scale }}>
      <KpmgMark height={cap} />
      <span style={{ width: 1, height: 26 * scale, background: 'var(--chrome-border-strong)' }} />
      <CreditIQLockup size={32 * scale} nameSize={cap} />
    </span>
  )
}
