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
 * The mark is four thin square outlines crossed by the italic wordmark. That
 * detail does not survive below about 20px, so the default is 21 rather than
 * whatever happens to fit — shrinking it until the squares turn to mush is how a
 * trademark ends up misused.
 */
export function KpmgMark({ height = 21, className = '' }: {
  height?: number; className?: string
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/brand/kpmg.svg')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (live && t.trim().startsWith('<svg')) setSvg(t) })
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
      style={{ height, color: 'var(--brand-kpmg)' }}
      aria-label="KPMG"
      role="img"
      // the file is a static asset we ship, and it is validated as an <svg>
      // before it is inserted
      dangerouslySetInnerHTML={{
        __html: svg.replace(
          '<svg',
          `<svg style="height:${height}px;width:auto;display:block;fill:currentColor"`,
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
