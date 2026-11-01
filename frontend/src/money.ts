// The API's limit for a single amount (MAX_CENTS in backend/src/dibs/schemas.py).
const MAX_CENTS = 10_000_000

// Turns what someone typed into integer cents, or null if it isn't a valid amount.
// Works on the digits as text, because float math gets money wrong: 19.99 * 100 is
// 1998.9999999999998 in JavaScript.
export function parseDollars(input: string): number | null {
  const match = input.trim().match(/^\$?(\d{0,7})(?:\.(\d{0,2}))?$/)
  if (!match) return null

  const whole = match[1]
  const fraction = match[2] ?? ''
  if (whole === '' && fraction === '') return null

  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return cents <= MAX_CENTS ? cents : null
}
