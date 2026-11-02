import { expect, test } from 'vitest'
import { parseContact } from './validation.ts'

test.each(['ana@example.com', ' Ana.B+dibs@mail.example.co.uk '])('%j is an email', (input) => {
  expect(parseContact(input)).toEqual({ phone: null, email: input.trim() })
})

test.each(['555-0100', '(555) 123-4567', '+1 555 123 4567', '555.123.4567', '5551234567'])(
  '%j is a phone number',
  (input) => {
    expect(parseContact(input)).toEqual({ phone: input, email: null })
  },
)

test.each([
  '',
  '   ',
  'ana',
  'ana@',
  '@example.com',
  'ana@example',
  'ana @example.com',
  '12345',
  '------',
  '555-CALL-NOW',
  '1'.repeat(33),
])('%j is neither', (input) => {
  expect(parseContact(input)).toBeNull()
})
