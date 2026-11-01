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

// The API answered with an error. Its message is safe to show to the user.
export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
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
  return response.json()
}

export function createBill(body: BillCreate): Promise<BillCreated> {
  return request('/bills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
