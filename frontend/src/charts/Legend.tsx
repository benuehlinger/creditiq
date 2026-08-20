/** A legend is present whenever there are two or more series — it is the
 *  dependable identity channel, and the reader is never asked to match colours
 *  from memory. A SINGLE series gets no legend box: there is only one colour and
 *  the chart title already says what is plotted, so a one-swatch box just
 *  restates the title and costs space.
 *
 *  Toggle-to-isolate is supported, and the swatch mirrors the mark: a short
 *  stroke for a line, a rounded rect for a bar or area. */
export default function Legend({
  items, kind = 'line', onToggle, hidden = [],
}: {
  items: { name: string; color: string }[]
  kind?: 'line' | 'rect'
  onToggle?: (name: string) => void
  hidden?: string[]
}) {
  if (items.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pb-1 pt-2">
      {items.map((it) => {
        const off = hidden.includes(it.name)
        return (
          <button
            key={it.name}
            onClick={() => onToggle?.(it.name)}
            disabled={!onToggle}
            className={`flex items-center gap-1.5 text-tiny transition-opacity ${
              off ? 'opacity-40' : ''
            } ${onToggle ? 'cursor-pointer' : 'cursor-default'}`}
          >
            {kind === 'line' ? (
              <span className="h-0.5 w-3 rounded-full" style={{ background: it.color }} />
            ) : (
              <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: it.color }} />
            )}
            {/* Text wears an ink token, never the series colour. Identity comes
                from the coloured mark beside it. */}
            <span className="text-ink-secondary">{it.name}</span>
          </button>
        )
      })}
    </div>
  )
}
