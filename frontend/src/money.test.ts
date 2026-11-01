import { expect, test } from 'vitest'
import { formatCents, parseDollars } from './money.ts'

test.each([
  [0, '$0.00'],
  [5, '$0.05'],
  [50, '$0.50'],
  [1999, '$19.99'],
  [123456, '$1,234.56'],
  [2_020_000_000, '$20,200,000.00'],
])('formats %i cents as %s', (cents, text) => {
  expect(formatCents(cents)).toBe(text)
})

test.each([
  ['12', 1200],
  ['12.5', 1250],
  ['12.50', 1250],
  ['12.', 1200],
  ['.5', 50],
  ['0', 0],
  ['$9.00', 900],
  [' 9.00 ', 900],
  // These all go wrong with float math.
  ['19.99', 1999],
  ['1.15', 115],
  ['4.35', 435],
  ['100000', 10_000_000],
])('parses %j as %i cents', (input, cents) => {
  expect(parseDollars(input)).toBe(cents)
})

test.each(['', ' ', '.', '$', 'abc', '-1', '1.234', '1,000', '1.2.3', '100000.01', '99999999'])(
  'rejects %j',
  (input) => {
    expect(parseDollars(input)).toBeNull()
  },
)
