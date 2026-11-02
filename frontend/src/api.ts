// Types here mirror backend/src/dibs/schemas.py.

// How often open bills check for changes while the live connection is down, and while it's up as
// a safety net, so a missed message can't leave a screen out of date for long.
export const POLL_INTERVAL_MS = 5000
export const LIVE_POLL_INTERVAL_MS = 30_000
export const RECONNECT_MAX_MS = 30_000

export type BillDetails = {
  restaurant_name: string | null
  tax_cents: number
  tip_cents: number
  fees_cents: number
  split_tip: boolean
  venmo_handle: string | null
  cashapp_tag: string | null
  zelle_contact: string | null
  items: { description: string; price_cents: number }[]
}

export type BillCreate = BillDetails & {
  captain_email: string
  captain_name: string
}

export type Bill = {
  share_code: string
  status: string
  restaurant_name: string | null
  subtotal_cents: number
  tax_cents: number
  tip_cents: number
  fees_cents: number
  total_cents: number
  split_tip: boolean
  venmo_handle: string | null
  cashapp_tag: string | null
  zelle_contact: string | null
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

export type Draft = {
  bill: Bill
  warnings: string[]
  printed_total_cents: number | null
}

export type DraftCreated = {
  draft: Draft
  crew_member_id: string
  token: string
}

export type ReceiptUpload = {
  upload_id: string
  url: string
  fields: Record<string, string>
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
    fees_cents: number
    total_cents: number
  }[]
  unclaimed_item_ids: string[]
  unclaimed_cents: number
}

export type PersonTotal = BillTotals['people'][number]

export type Settlement = PersonTotal & {
  id: string
  status: 'OWED' | 'MARKED_PAID' | 'CONFIRMED'
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

export function createReceiptUpload(): Promise<ReceiptUpload> {
  return request('/receipts/upload-url', { method: 'POST' })
}

// Sends the photo straight to S3, not through the API. S3 requires the file to be the last field,
// and the browser adds the Content-Type header with the boundary that separates the fields.
export async function uploadPhoto(upload: ReceiptUpload, photo: Blob): Promise<void> {
  const form = new FormData()
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value)
  form.append('file', photo, 'receipt.jpg')
  const response = await fetch(upload.url, { method: 'POST', body: form })
  if (!response.ok) {
    throw new ApiError(response.status, "Your photo couldn't be uploaded. Try again.")
  }
}

export function createBillFromReceipt(
  uploadId: string,
  captainEmail: string,
  captainName: string,
  restaurantName: string | null,
): Promise<DraftCreated> {
  return request('/bills/from-receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_id: uploadId,
      captain_email: captainEmail,
      captain_name: captainName,
      restaurant_name: restaurantName,
    }),
  })
}

export function getDraft(shareCode: string, token: string): Promise<Draft> {
  return request(`/bills/${encodeURIComponent(shareCode)}/draft`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

export function updateDraft(shareCode: string, token: string, body: BillDetails): Promise<Draft> {
  return request(`/bills/${encodeURIComponent(shareCode)}/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

export function openBill(shareCode: string, token: string): Promise<Bill> {
  return request(`/bills/${encodeURIComponent(shareCode)}/open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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

export function previewLock(
  shareCode: string,
  token: string,
  assignments: Record<string, string>,
): Promise<BillTotals> {
  return request(`/bills/${encodeURIComponent(shareCode)}/lock/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assignments }),
  })
}

export function lockBill(
  shareCode: string,
  token: string,
  assignments: Record<string, string>,
): Promise<Bill> {
  return request(`/bills/${encodeURIComponent(shareCode)}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assignments }),
  })
}

export function reopenBill(shareCode: string, token: string): Promise<Bill> {
  return request(`/bills/${encodeURIComponent(shareCode)}/reopen`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export function getSettlements(shareCode: string): Promise<Settlement[]> {
  return request(`/bills/${encodeURIComponent(shareCode)}/settlements`)
}

export function markPaid(shareCode: string, token: string): Promise<Settlement> {
  return request(`/bills/${encodeURIComponent(shareCode)}/settlements/mine/paid`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export function confirmPayment(
  shareCode: string,
  token: string,
  settlementId: string,
): Promise<Settlement> {
  return request(`/bills/${encodeURIComponent(shareCode)}/settlements/${settlementId}/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export function paymentNotReceived(
  shareCode: string,
  token: string,
  settlementId: string,
): Promise<Settlement> {
  return request(`/bills/${encodeURIComponent(shareCode)}/settlements/${settlementId}/not-received`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export function getTotals(shareCode: string): Promise<BillTotals> {
  return request(`/bills/${encodeURIComponent(shareCode)}/totals`)
}

// What someone's total would be with these items. Nothing is saved.
export function previewMyClaims(
  shareCode: string,
  token: string,
  itemIds: string[],
): Promise<PersonTotal> {
  return request(`/bills/${encodeURIComponent(shareCode)}/my-claims/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ item_ids: itemIds }),
  })
}

// Saves exactly these items as someone's claims, all in one step.
export function saveMyClaims(
  shareCode: string,
  token: string,
  itemIds: string[],
): Promise<PersonTotal> {
  return request(`/bills/${encodeURIComponent(shareCode)}/my-claims`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ item_ids: itemIds }),
  })
}
