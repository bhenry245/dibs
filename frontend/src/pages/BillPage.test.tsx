import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, type Mock, test, vi } from 'vitest'
import { ApiError, shouldRetry } from '../api.ts'
import App from '../App.tsx'

const BILL = {
  share_code: 'abc123',
  status: 'OPEN',
  restaurant_name: "Luigi's",
  subtotal_cents: 3900,
  tax_cents: 312,
  tip_cents: 780,
  total_cents: 4992,
  split_tip: true,
  items: [
    { id: 'i1', description: 'Burger', price_cents: 2000, position: 0, claims: [] },
    { id: 'i2', description: 'Salad', price_cents: 1000, position: 1, claims: [] },
    { id: 'i3', description: 'Nachos', price_cents: 900, position: 2, claims: [] },
  ],
  crew: [{ id: 'cap', name: 'Brandon', is_captain: true }],
}

const JOINED = { crew_member_id: 'ana', token: 'ana-token' }

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

// Serves the bill and answers joins. Once someone has joined, the bill includes them.
function stubApi({
  bill = BILL as unknown,
  billStatus = 200,
  join = (): unknown => jsonResponse(201, JOINED),
} = {}): Mock {
  let joined = false
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/totals')) {
      return jsonResponse(200, { people: [], unclaimed_item_ids: [] })
    }
    if (init?.method === 'POST') {
      const response = await join()
      joined = true
      return response
    }
    const crew = joined ? [...BILL.crew, { id: 'ana', name: 'Ana', is_captain: false }] : BILL.crew
    return jsonResponse(billStatus, joined ? { ...BILL, crew } : bill)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderBillPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/b/abc123']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function joinCalls(fetchMock: Mock) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('shows the bill to someone who just scanned the QR', async () => {
  const fetchMock = stubApi()

  renderBillPage()

  expect(await screen.findByRole('heading', { name: "Luigi's" })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/bills/abc123', undefined)
  expect(screen.getByText('Burger')).toBeInTheDocument()
  expect(screen.getByText('$20.00')).toBeInTheDocument()
  expect(screen.getByText('$49.92')).toBeInTheDocument()
  expect(screen.getByText('At the table: Brandon')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Join this bill' })).toBeInTheDocument()
})

test('a bill with no restaurant name still has a title', async () => {
  stubApi({ bill: { ...BILL, restaurant_name: null } })

  renderBillPage()

  expect(await screen.findByRole('heading', { name: 'Your bill' })).toBeInTheDocument()
})

test('joining sends the details, keeps the token and lets them in', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderBillPage()

  await user.type(await screen.findByLabelText('Your name'), '  Ana ')
  await user.type(screen.getByLabelText('Email'), 'ana@example.com')
  await user.click(screen.getByRole('button', { name: 'Join' }))

  expect(await screen.findByText("You're in, Ana.")).toBeInTheDocument()
  const [url, init] = joinCalls(fetchMock)[0]
  expect(url).toBe('/api/bills/abc123/join')
  expect(JSON.parse(init.body)).toEqual({ name: 'Ana', phone: null, email: 'ana@example.com' })
  expect(JSON.parse(localStorage.getItem('dibs.identity.abc123')!)).toEqual({
    crewMemberId: 'ana',
    token: 'ana-token',
  })
  expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
  expect(await screen.findByText('At the table: Brandon, Ana')).toBeInTheDocument()
})

test('a phone number alone is enough to join', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderBillPage()

  await user.type(await screen.findByLabelText('Your name'), 'Ana')
  await user.type(screen.getByLabelText('Phone'), '555-0100')
  await user.click(screen.getByRole('button', { name: 'Join' }))

  await screen.findByText("You're in, Ana.")
  expect(JSON.parse(joinCalls(fetchMock)[0][1].body)).toEqual({
    name: 'Ana',
    phone: '555-0100',
    email: null,
  })
})

test('asks for a phone or email before joining', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderBillPage()

  await user.type(await screen.findByLabelText('Your name'), 'Ana')
  await user.type(screen.getByLabelText('Phone'), '   ')
  await user.click(screen.getByRole('button', { name: 'Join' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Add a phone number or an email.')
  expect(joinCalls(fetchMock)).toHaveLength(0)
})

test('coming back to the page does not ask them to join again', async () => {
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'cap', token: 'cap-token' }),
  )
  stubApi()

  renderBillPage()

  expect(await screen.findByText("You're in, Brandon.")).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
})

test('a saved identity for someone not on the bill gets the join form', async () => {
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'gone', token: 'old-token' }),
  )
  stubApi()

  renderBillPage()

  expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument()
})

test('a saved identity from another bill does not count', async () => {
  localStorage.setItem(
    'dibs.identity.other-bill',
    JSON.stringify({ crewMemberId: 'cap', token: 'other-token' }),
  )
  stubApi()

  renderBillPage()

  expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument()
})

test('damaged saved data gets the join form instead of a crash', async () => {
  localStorage.setItem('dibs.identity.abc123', '{not json')
  stubApi()

  renderBillPage()

  expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument()
})

test('a locked bill can be seen but not joined', async () => {
  stubApi({ bill: { ...BILL, status: 'LOCKED' } })

  renderBillPage()

  expect(await screen.findByText('This bill is locked, so nobody new can join.')).toBeInTheDocument()
  expect(screen.getByText('Burger')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
})

test('someone already on a locked bill still counts as in', async () => {
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'cap', token: 'cap-token' }),
  )
  stubApi({ bill: { ...BILL, status: 'LOCKED' } })

  renderBillPage()

  expect(await screen.findByText("You're in, Brandon.")).toBeInTheDocument()
})

test('shows when the bill locks just as they join, and keeps what they typed', async () => {
  const user = userEvent.setup()
  stubApi({ join: () => jsonResponse(409, { detail: 'bill is not open' }) })
  renderBillPage()

  await user.type(await screen.findByLabelText('Your name'), 'Ana')
  await user.type(screen.getByLabelText('Phone'), '555-0100')
  await user.click(screen.getByRole('button', { name: 'Join' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('bill is not open')
  expect(screen.getByLabelText('Your name')).toHaveValue('Ana')
  expect(localStorage.getItem('dibs.identity.abc123')).toBeNull()
})

test('a second tap while joining does not add them twice', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const fetchMock = stubApi({ join: () => new Promise((resolve) => (finish = resolve)) })
  renderBillPage()

  await user.type(await screen.findByLabelText('Your name'), 'Ana')
  await user.type(screen.getByLabelText('Phone'), '555-0100')
  await user.click(screen.getByRole('button', { name: 'Join' }))
  const button = await screen.findByRole('button', { name: 'Joining…' })
  expect(button).toBeDisabled()
  await user.click(button)

  expect(joinCalls(fetchMock)).toHaveLength(1)
  finish(jsonResponse(201, JOINED))
  await screen.findByText("You're in, Ana.")
})

test('an unknown or draft bill says it was not found', async () => {
  stubApi({ billStatus: 404, bill: { detail: 'bill not found' } })

  renderBillPage()

  expect(await screen.findByRole('heading', { name: 'Bill not found' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
})

test('a failed load can be tried again', async () => {
  const user = userEvent.setup()
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue(jsonResponse(200, BILL))
  vi.stubGlobal('fetch', fetchMock)
  renderBillPage()

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByRole('heading', { name: "Luigi's" })).toBeInTheDocument()
})

test('retries only when another try could help', () => {
  expect(shouldRetry(0, new ApiError(404, 'bill not found'))).toBe(false)
  expect(shouldRetry(0, new ApiError(422, 'bad input'))).toBe(false)
  expect(shouldRetry(0, new ApiError(500, 'server error'))).toBe(true)
  expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true)
  expect(shouldRetry(3, new TypeError('Failed to fetch'))).toBe(false)
})
