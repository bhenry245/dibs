// A quick check to catch typos before sending. The API has the final say on what's a valid email.
export function isValidEmail(email: string): boolean {
  return /^\S+@\S+\.\S+$/.test(email.trim())
}
