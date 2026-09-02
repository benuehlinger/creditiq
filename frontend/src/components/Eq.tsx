import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * A typeset mathematical expression.
 *
 * The methodology captions carried equations as plain text — `E[LGD] =
 * sigmoid(X·β)`, `logit(bin mean) − logit(book mean)` — which read as code, not
 * mathematics. KaTeX renders them the way a paper would: real script for the
 * variables, proper operator spacing, a true summation sign. It is self-hosted
 * from node_modules, fonts and all, so it renders with no network call and the
 * offline guarantee holds.
 *
 * `display` centres the expression on its own line, for a defining equation.
 * The default is inline, sitting on the text baseline within a sentence.
 */
export default function Eq({ tex, display = false, className = '' }: {
  tex: string; display?: boolean; className?: string
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display, throwOnError: false, output: 'html',
      })
    } catch {
      return tex
    }
  }, [tex, display])
  return (
    <span className={`${display ? 'block my-1 text-center' : 'inline'} ${className}`}
          // KaTeX emits sanitised, self-contained markup from a TeX string that
          // is authored here, never user input.
          dangerouslySetInnerHTML={{ __html: html }} />
  )
}
