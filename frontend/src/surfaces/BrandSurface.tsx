import { useUi } from '../lib/store'
import { Card, CardHead } from '../components/ui'
import {
  BRAND_DIRECTIONS, BrandDescriptor, CoBrand, type CoBrandVariant,
  CreditIQMark, CreditIQWordmark, KpmgMark, MarkCurve, MarkMonogram,
} from '../components/Brand'

/**
 * Brand directions, judged where brands are judged: in context.
 *
 * Each lockup structure renders inside a mock of the real header, at the real
 * size, with the real KPMG artwork — a specimen sheet at display sizes fools
 * everyone. Clicking one adopts it, and the actual header above changes at the
 * same moment, so a candidate is evaluated live rather than imagined. The
 * choice persists until changed here.
 *
 * This page is a working surface for the engagement team, not part of the
 * client demo. It is reachable from the command palette only.
 */
export default function BrandSurface() {
  const adopted = useUi((s) => s.brandVariant) as CoBrandVariant
  const setBrandVariant = useUi((s) => s.setBrandVariant)

  return (
    <div className="mx-auto max-w-[980px] space-y-3 p-4">
      <Card>
        <CardHead
          title="Brand directions"
          subtitle="Click a structure to adopt it. The header above changes immediately."
          caption="Both marks stay separate in every direction: KPMG says who built it, CreditIQ says what it is, and they are never fused into one graphic. What varies is hierarchy — how much room the firm takes beside the product." />
      </Card>

      {/* ── lockup structure ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        {BRAND_DIRECTIONS.map((d) => (
          <button key={d.key} onClick={() => setBrandVariant(d.key)}
            className={`block w-full rounded-card border text-left transition-colors ${
              adopted === d.key ? 'border-accent' : 'border-hairline hover:border-accent/50'}`}>
            {/* the mock header strip: same height, surface and padding as the
                real one, with a hint of its right side for context */}
            <div className="flex h-16 items-center gap-5 rounded-t-card border-b border-hairline bg-raised px-5">
              <CoBrand variant={d.key} />
              <span className="ml-auto hidden items-center gap-3 text-micro text-ink-muted sm:flex">
                <span>26 MEV series · offline</span>
                <span className="rounded border border-hairline px-1.5 py-0.5">
                  Synthetic demonstration data
                </span>
              </span>
            </div>
            <div className="flex items-baseline gap-3 px-5 py-2.5">
              <span className="text-xs font-semibold text-ink">{d.label}</span>
              {adopted === d.key && (
                <span className="flex items-center gap-1.5 text-tiny font-medium text-ink-secondary">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Adopted
                </span>
              )}
              <span className="max-w-[70ch] text-tiny leading-relaxed text-ink-muted">{d.note}</span>
            </div>
          </button>
        ))}
      </div>

      {/* ── the product mark ─────────────────────────────────────────────── */}
      <Card>
        <CardHead title="Product mark"
          subtitle="Used by the favicon, the Mark lockup above, and a title slide"
          caption="Three ideas. Each is shown at slide, header and favicon size, because the only real test of a mark is whether it survives 16 pixels." />
        <div className="grid gap-px bg-hairline sm:grid-cols-3">
          {[
            { key: 'bars', label: 'Binning and hazard',
              note: 'Three ascending bars under a fitted curve: the two things the product actually does. The current favicon.',
              render: (n: number) => <CreditIQMark size={n} /> },
            { key: 'monogram', label: 'Monogram',
              note: 'The initials knocked out of a plate in the wordmark’s own serif. Quietest; closest to how an index provider marks a tool.',
              render: (n: number) => <MarkMonogram size={n} /> },
            { key: 'curve', label: 'Instrument glyph',
              note: 'The hazard alone, drawn as a fine line over binned ticks. No plate, takes the surface’s ink; reads as an instrument rather than an app icon.',
              render: (n: number) => <span className="text-ink"><MarkCurve size={n} /></span> },
          ].map((m) => (
            <div key={m.key} className="bg-raised px-5 py-4">
              <div className="flex items-end gap-4">
                {m.render(64)}{m.render(28)}{m.render(16)}
              </div>
              <div className="mt-3 text-xs font-semibold text-ink">{m.label}</div>
              <p className="mt-1 text-tiny leading-relaxed text-ink-muted">{m.note}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* ── title slide ──────────────────────────────────────────────────── */}
      <Card>
        <CardHead title="Title slide"
          subtitle="The opening frame of the deck"
          caption="The same system at display size. On the field, the name takes the light ink and KPMG signs the corner; on paper, the inverse." />
        <div className="grid gap-px bg-hairline sm:grid-cols-2">
          <div className="flex min-h-[220px] flex-col justify-between p-8"
               style={{ background: '#00338D',
                        ['--brand-name' as string]: '#FFFFFF',
                        ['--brand-kpmg' as string]: '#FFFFFF' }}>
            <div>
              <CreditIQWordmark size={40} />
              <BrandDescriptor size={10} className="mt-3 !text-white/60" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-tiny text-white/60">Prepared for Apollo FIG</span>
              <span style={{ ['--brand-kpmg' as string]: '#FFFFFF' }}>
                <CoBrandKpmgOnly />
              </span>
            </div>
          </div>
          <div className="flex min-h-[220px] flex-col justify-between bg-raised p-8">
            <div>
              <CreditIQWordmark size={40} />
              <BrandDescriptor size={10} className="mt-3" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-tiny text-ink-muted">Prepared for Apollo FIG</span>
              <CoBrandKpmgOnly />
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

/** KPMG alone, small, for signing the corner of a slide. */
function CoBrandKpmgOnly() {
  return <span className="opacity-90"><KpmgMark height={12} /></span>
}
