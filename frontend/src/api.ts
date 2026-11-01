// Types here mirror backend/src/dibs/schemas.py.

export type BillCreate = {
  captain_email: string
  captain_name: string
  restaurant_name: string | null
  tax_cents: number
  tip_cents: number
  split_tip: boolean
  items: { description: string; price_cents: number }[]
}

export type Bill = {
  share_code: string
  status: string
  restaurant_name: string | null
  subtotal_cents: number
  tax_cents: number
  tip_cents: number
  total_cents: number
  split_tip: boolean
  items: {
    id: string
    description: string
    price_cents: number
    position: number
    claims: { crew_member_id: string; shares: number }[]
  }[]
  crew: { id: string; name: string; is_captain: boolean }[]
}

export type BillCreated = {
  bill: Bill
  crew_member_id: string
  token: string
}

export type JoinRequest = {
  name: string
  phone: string | null
  email: string | null
}

export type JoinResponse = {
  crew_member_id: string
  token: string
}

export type BillTotals = {
  people: {
    crew_member_id: string
    name: string
    subtotal_cents: number
    tax_cents: number
    tip_cents: number
    total_cents: number
  }[]
  unclaimed_item_ids: string[]
}

// The API answered with an error. Its message is safe to show to the user.
export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Text to show the user for a failed request. Anything but an ApiError means we got no answer.
export function describeError(error: Error): string {
  return error instanceof ApiError
    ? error.message
    : "Couldn't reach Dibs. Check your connection and try again."
}

// Retry when the server or network might recover, but not when the API has given its answer:
// a bill that doesn't exist won't appear by asking again.
export function shouldRetry(failureCount: number, error: Error): boolean {
  const apiSaidNo = error instanceof ApiError && error.status < 500
  return !apiSaidNo && failureCount < 3
}

// FastAPI sends detail as a string for errors we raise, and as a list for failed validation.
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const { detail } = await response.json()
    if (typeof detail === 'string') return detail
    return detail
      .map((error: { msg: string }) => error.msg.replace(/^Value error, /, ''))
      .join('. ')
  } catch {
    return 'Something went wrong. Please try again.'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response))
  }
  // 204 means success with an empty body, so there's no JSON to read.
  return response.status === 204 ? (undefined as T) : response.json()
}

export function createBill(body: BillCreate): Promise<BillCreated> {
  return request('/bills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getBill(shareCode: string): Promise<Bill> {
  return request(`/bills/${encodeURIComponent(shareCode)}`)
}

export function joinBill(shareCode: string, body: JoinRequest): Promise<JoinResponse> {
  return request(`/bills/${encodeURIComponent(shareCode)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getTotals(shareCode: string): Promise<BillTotals> {
  return request(`/bills/${encodeURIComponent(shareCode)}/totals`)
}

export function claimItem(itemId: string, token: string): Promise<void> {
  return request(`/items/${itemId}/claim`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ shares: 1 }),
  })
}

export function unclaimItem(itemId: string, token: string): Promise<void> {
  return request(`/items/${itemId}/claim`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}
