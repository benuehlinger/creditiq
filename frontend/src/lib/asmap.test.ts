import { describe, expect, it } from 'vitest'
import { asMap } from './api'

describe('asMap', () => {
  it('passes a plain mapping through', () => {
    expect(asMap({ cltv: 'spline', dti: 'bins' }))
      .toEqual({ cltv: 'spline', dti: 'bins' })
  })

  it('converts the list-of-pairs form the server used to send', () => {
    expect(asMap([['cltv', 'spline'], ['dti', 'bins']]))
      .toEqual({ cltv: 'spline', dti: 'bins' })
  })

  it('repairs an object corrupted by spreading the list form', () => {
    // {...[['cltv','spline']], hpi_yoy: 'bins'} produces an index key, and that
    // shape is already sitting in browser storage from an earlier build. It
    // must be readable, not merely rejected.
    const corrupted = { 0: ['cltv', 'spline'], hpi_yoy: 'bins' }
    expect(asMap(corrupted)).toEqual({ cltv: 'spline', hpi_yoy: 'bins' })
  })

  it('is safe to spread — the whole point', () => {
    const corrupted = { 0: ['cltv', 'spline'] }
    expect({ ...asMap(corrupted), dti: 'bins' })
      .toEqual({ cltv: 'spline', dti: 'bins' })
    // spreading the RAW value is what produced the bug
    expect({ ...corrupted, dti: 'bins' }).toHaveProperty('0')
  })

  it('handles numeric payloads, not just strings', () => {
    expect(asMap<number[]>([['cltv', [0.6, 0.9]]])).toEqual({ cltv: [0.6, 0.9] })
    expect(asMap<number[]>({ 0: ['cltv', [0.6, 0.9]] })).toEqual({ cltv: [0.6, 0.9] })
  })

  it('treats null and undefined as empty', () => {
    expect(asMap(null)).toEqual({})
    expect(asMap(undefined)).toEqual({})
    expect(asMap([])).toEqual({})
  })
})
