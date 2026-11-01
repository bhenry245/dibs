// Who you are on a bill. The token is only ever sent once, so it has to be kept on the device
// (design §15). One entry per bill, because tokens only work for the bill they came from.

export type Identity = {
  crewMemberId: string
  token: string
}

export function saveIdentity(shareCode: string, identity: Identity): void {
  try {
    localStorage.setItem(`dibs.identity.${shareCode}`, JSON.stringify(identity))
  } catch {
    // Storage can be blocked, such as in some private windows. The bill still exists, so carry on.
  }
}

export function loadIdentity(shareCode: string): Identity | null {
  try {
    const saved = localStorage.getItem(`dibs.identity.${shareCode}`)
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}
