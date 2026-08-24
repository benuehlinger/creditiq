import { useRef } from 'react'
import { Card, CardHead } from '../components/ui'
import {
  CO_BRAND_VARIANTS, CandidateLockup, CoBrand, CoBrandVariantMark, CreditIQHero,
  CreditIQLockup, CreditIQMark, CreditIQWordmark, WORDMARK_CANDIDATES,
} from '../components/Brand'
import { useUi } from '../lib/store'

/**
 * Brand assets, in one place.
 *
 * This is not chrome for the product — it is a working page for building a deck.
 * A logo that only exists inside a React header is useless the moment someone
 * needs it on a title slide, so every mark here exports to PNG at presentation
 * resolution, on the surface it will actually sit on.
 */
export default function BrandSurface() {
  // re-render on a theme change so the exports pick up the current surface
  useUi((s) => s.theme)

  return (
    <div className="space-y-3 p-4">
      <Card>
        <CardHead
          title="Brand assets"
          subtitle="Export at 3x for a deck · rendered in the current theme"
          caption="Two marks, always separate. KPMG identifies who built it; CreditIQ identifies what it is, and they are never combined into a single graphic. How much room each takes is a choice — the treatments below are the options, and the header renders whichever is adopted."
        />
        <div className="space-y-px bg-hairline">
          <Exportable name="creditiq-hero" label="Hero lockup" note="Title slides, covers">
            <CreditIQHero />
          </Exportable>
          <Exportable name="creditiq-lockup" label="Standard lockup" note="Where the mark stands alone">
            <CreditIQLockup size={40} nameSize={26} />
          </Exportable>
          <Exportable name="creditiq-mark" label="Mark only" note="Favicons, avatars, small placements">
            <CreditIQMark size={72} />
          </Exportable>
          <Exportable name="creditiq-wordmark" label="Wordmark only" note="Where the mark would crowd">
            <CreditIQWordmark size={34} />
          </Exportable>
          <Exportable name="kpmg-cobrand" label="Co-brand row" note="Exactly what the application header renders">
            <CoBrand scale={1.35} />
          </Exportable>
        </div>
      </Card>

      <Card>
        <CardHead
          title="Wordmark face — candidates"
          subtitle="Each rendered in the real lockup, cap height matched to the KPMG letters"
          caption="A specimen sheet is the wrong place to choose a wordmark: what matters is how the name sits against the KPMG mark at header size, and that is a relationship rather than a property of the face. Matching CAP HEIGHT rather than font size keeps the comparison like for like — a face with small caps is not penalised for looking smaller at the same point size."
        />
        <div className="space-y-px bg-hairline">
          {WORDMARK_CANDIDATES.map((c) => (
            <div key={c.key} className="flex items-center gap-6 bg-surface px-4 py-5">
              <div className="min-w-0 flex-1">
                <CandidateLockup stack={c.stack} weight={c.weight} cap={c.cap} scale={1.3} />
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs font-medium text-ink">{c.label}</div>
                <div className="max-w-xs text-micro leading-relaxed text-ink-muted">{c.note}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead
          title="Co-brand treatments"
          subtitle="Four ways to divide the room between the firm and the product"
          caption="These differ in HIERARCHY, not decoration — which is the only thing worth having options about. All four are driven from the KPMG cap height, because that artwork is the fixed quantity: it belongs to someone else and cannot be redrawn to fit."
        />
        <div className="space-y-px bg-hairline">
          {CO_BRAND_VARIANTS.map((v) => (
            <Exportable key={v.key} name={`cobrand-${v.key}`} label={v.label} note={v.note}>
              <CoBrandVariantMark variant={v.key} scale={1.35} />
            </Exportable>
          ))}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHead title="What the mark means"
            caption="The construction of the mark, stated so it can be reproduced." />
          <div className="space-y-3 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
            <p>
              Three ascending bars under a curve: a <span className="text-ink">binning</span>,
              with a <span className="text-ink">fitted hazard</span> running through it. Those
              are the two things this product actually does, so the mark says what the
              tool is rather than decorating it.
            </p>
            <p>
              The bars carry the same specs as every chart in the app — capped
              thickness, rounded data ends, a surface gap between them. It reads at
              20px in a header and at 96px on a title slide, which is the only real
              test of a mark.
            </p>
          </div>
        </Card>

        <Card>
          <CardHead title="Colour and type"
            caption="The permitted sizes and clear space for each mark." />
          <dl className="space-y-2 px-4 py-3 text-xs">
            <Row k="Wordmark, light surface" v="#00338D — the true KPMG deep blue" />
            <Row k="Wordmark, dark surface"
                 v="#4DA3E8 — the deep blue reads at 1.67:1 on dark, which is unreadable, so the mark steps to the same brand hue at a legible lightness" />
            <Row k="Accent on “IQ”" v="#0091DA light · #4DA3E8 dark — KPMG light blue" />
            <Row k="Display face" v="Space Grotesk, self-hosted, 22 KB variable" />
            <Row k="Everything else" v="System sans — charts, axis labels and every number. A display face on a hero figure reads as off-brand decoration, and tabular alignment depends on the system metrics." />
          </dl>
        </Card>
      </div>

      <Card>
        <div className="px-4 py-3 text-xs leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">On the KPMG mark.</span>{' '}
          The file currently shipped is the Wikimedia Commons vector, used as a
          stand-in so the layout is real rather than a grey box. Replace{' '}
          <code className="font-mono text-tiny">frontend/public/brand/kpmg.svg</code>{' '}
          with the asset from the internal brand portal before this goes in front of
          a client — the mark is a registered trademark and the internal file is the
          authoritative one. It is loaded at runtime, so swapping it is a file copy
          and nothing in the code changes.
        </div>
      </Card>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-hairline pb-2 last:border-0">
      <dt className="shrink-0 text-ink-muted">{k}</dt>
      <dd className="text-right text-ink-secondary">{v}</dd>
    </div>
  )
}

function Exportable({ name, label, note, children }: {
  name: string; label: string; note: string; children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  const download = async (scale: number) => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    // Inline the SVG plus the computed brand variables into a standalone
    // document. An SVG that references CSS custom properties from the page is
    // not portable — dropped into a deck it renders black.
    const cs = getComputedStyle(document.documentElement)
    const vars = ['--brand-name', '--brand-name-accent', '--brand-mark-bg',
                  '--brand-mark-bar', '--brand-mark-curve', '--brand-kpmg',
                  '--ink-muted', '--chrome-border-strong']
      .map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(';')
    const font = cs.getPropertyValue('--surface-chart').trim()
    const html = `<div xmlns="http://www.w3.org/1999/xhtml" style="${vars};background:${font};` +
      `padding:24px;display:inline-block;font-family:'Space Grotesk',system-ui,sans-serif">` +
      el.innerHTML + '</div>'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 48}" height="${height + 48}">` +
      `<foreignObject width="100%" height="100%">${html}</foreignObject></svg>`

    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await new Promise((res) => { img.onload = res; img.onerror = res })
    const canvas = document.createElement('canvas')
    canvas.width = (width + 48) * scale
    canvas.height = (height + 48) * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${name}@${scale}x.png`
    a.click()
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 bg-surface px-5 py-6">
      <div ref={ref} className="flex items-center">{children}</div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-xs text-ink">{label}</div>
          <div className="text-micro text-ink-muted">{note}</div>
        </div>
        <button onClick={() => download(3)}
          className="rounded border border-hairline px-2 py-1 text-micro text-ink-muted hover:text-ink">
          PNG 3x
        </button>
      </div>
    </div>
  )
}
