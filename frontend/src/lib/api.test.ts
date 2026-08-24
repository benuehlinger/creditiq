import { describe, expect, it } from 'vitest'
import { errorText } from './api'

describe('errorText', () => {
  it('reads a raised HTTPException detail straight through', () => {
    expect(errorText({ detail: 'select at least one driver' }, 'fallback'))
      .toBe('select at least one driver')
  })

  it('names the fields in a validation failure instead of stringifying objects', () => {
    // FastAPI returns `detail` as a LIST for a validation failure. Handing that
    // to `new Error()` produced "[object Object],[object Object],[object Object]"
    // on the LGD fit screen — three fields rejected, none of them named.
    const body = {
      detail: [
        { loc: ['body', 'treatments'], msg: 'Input should be a valid dictionary' },
        { loc: ['body', 'edges'], msg: 'Input should be a valid dictionary' },
        { loc: ['body', 'knots'], msg: 'Input should be a valid dictionary' },
      ],
    }
    const text = errorText(body, 'fallback')
    expect(text).not.toMatch(/\[object Object\]/)
    expect(text).toBe('treatments: Input should be a valid dictionary; '
      + 'edges: Input should be a valid dictionary; '
      + 'knots: Input should be a valid dictionary')
  })

  it('drops the leading source from the location path', () => {
    expect(errorText({ detail: [{ loc: ['body', 'lgd', 'knots'], msg: 'bad' }] }, 'f'))
      .toBe('lgd.knots: bad')
  })

  it('falls back when the body carries no detail at all', () => {
    expect(errorText(null, 'Internal Server Error')).toBe('Internal Server Error')
    expect(errorText({}, 'Bad Request')).toBe('Bad Request')
    expect(errorText({ detail: [] }, 'Bad Request')).toBe('Bad Request')
  })
})
