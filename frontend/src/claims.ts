import type { Bill } from './api.ts'

type Item = Bill['items'][number]

export function isClaimedBy(item: Item, crewMemberId: string): boolean {
  return item.claims.some((claim) => claim.crew_member_id === crewMemberId)
}

// The names of everyone else who has claimed an item.
export function otherClaimers(item: Item, bill: Bill, myId: string): string[] {
  return item.claims
    .filter((claim) => claim.crew_member_id !== myId)
    .map((claim) => bill.crew.find((member) => member.id === claim.crew_member_id)?.name ?? '?')
}

// Turns a list of names into a sentence: "Anna", "Anna and Ben", "Anna, Ben and Cam".
export function listNames(names: string[]): string {
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)
}
