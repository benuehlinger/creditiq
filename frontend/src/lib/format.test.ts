import { describe, expect, it } from 'vitest'
import { month, monthLong, monthShort } from './format'

describe('date formatting on a time axis', () => {
  // A `type: 'time'` axis reports its value as a millisecond TIMESTAMP, not as
  // the ISO string that went in. Appending 'T00:00:00' to a number gave
  // `new Date("1767225600000T00:00:00")`, so every crosshair tooltip on a time
  // axis printed "Invalid Date" as its header.
  const iso = '2020-03-01'
  const stamp = new Date('2020-03-01T00:00:00').getTime()

  it('reads a millisecond timestamp, not only an ISO string', () => {
    expect(month(stamp)).toBe('Mar 2020')
    expect(month(stamp)).not.toMatch(/Invalid/)
    expect(monthLong(stamp)).toBe('Mar 2020')
    expect(monthShort(stamp)).toBe('Mar')
  })

  it('still reads an ISO date the same way', () => {
    expect(month(iso)).toBe('Mar 2020')
    expect(month(iso)).toBe(month(stamp))
  })

  it('keeps a bare date on its own day rather than shifting it west of UTC', () => {
    // Parsed as UTC, '2020-03-01' lands on 29 February in any negative offset.
    expect(month('2020-03-01')).toBe('Mar 2020')
    expect(monthShort('2021-01-01')).toBe('2021')
  })
})
