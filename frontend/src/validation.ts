// A quick check to catch typos before sending. The API has the final say on what's a valid email.
const PHONE = /^\+?[\d\s().-]{7,32}$/
const MIN_PHONE_DIGITS = 7

// Works out what someone typed into a single "phone or email" box, or null if it's neither yet.
// Anything with an @ is treated as an email, so a typo gets caught instead of saved as a phone.
export function parseContact(input: string): { phone: string | null; email: string | null } | null {
  const contact = input.trim()
  if (contact.includes('@')) {
    return isValidEmail(contact) ? { phone: null, email: contact } : null
  }
  const digits = contact.replace(/\D/g, '')
  return PHONE.test(contact) && digits.length >= MIN_PHONE_DIGITS
    ? { phone: contact, email: null }
    : null
}

export function isValidEmail(email: string): boolean {
  return /^\S+@\S+\.\S+$/.test(email.trim())
}
