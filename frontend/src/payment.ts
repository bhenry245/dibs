import { centsToInput } from './money.ts'

// Opens the payment app ready to pay this amount. Dibs never touches the money. Handles are typed by
// the Captain, so they're encoded to keep them from changing where the link goes.
export function venmoLink(handle: string, cents: number, note: string): string {
  const user = encodeURIComponent(handle.trim().replace(/^@/, ''))
  return `https://venmo.com/${user}?txn=pay&amount=${centsToInput(cents)}&note=${encodeURIComponent(note)}`
}

export function cashAppLink(tag: string, cents: number): string {
  const user = encodeURIComponent(tag.trim().replace(/^\$/, ''))
  return `https://cash.app/$${user}/${centsToInput(cents)}`
}
