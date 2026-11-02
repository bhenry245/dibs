import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, type Mock, test, vi } from 'vitest'
import App from '../App.tsx'

type Claim = { crew_member_id: string; shares: number }

const CREW = [
  { id: 'cap', name: 'Brandon', is_captain: true },
  { id: 'ana', name: 'Anna', is_captain: false },
]

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

function row(id: string, name: string, totalCents: number, status = 'OWED') {
  return {
    id: `s-${id}`,
    crew_member_id: id,
    name,
    subtotal_cents: totalCents,
    tax_cents: 0,
    tip_cents: 0,
    fees_cents: 0,
    total_cents: totalCents,
    status,
  }
}

function personTotal(id: string, totalCents: number) {
  const { id: _id, status: _status, ...rest } = row(id, CREW.find((m) => m.id === id)!.name, totalCents)
  return rest
}

function fakeApi({
  status = 'OPEN',
  settlements = [] as ReturnType<typeof row>[],
  handles = {} as Record<string, string>,
  lockResponse,
  actionResponse,
}: {
  status?: string
  settlements?: ReturnType<typeof row>[]
  handles?: Record<string, string>
  lockResponse?: () => unknown
  actionResponse?: () => unknown
} = {}) {
  const state = {
    status,
    settlements,
    claims: { burger: [], salad: [{ crew_member_id: 'ana', shares: 1 }] } as Record<string, Claim[]>,
  }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/lock/preview')) {
      const { assignments } = JSON.parse(init!.body as string)
      const burgerGoesToAna = assignments.burger === 'ana'
      return jsonResponse(200, {
        people: [personTotal('cap', burgerGoesToAna ? 0 : 2000), personTotal('ana', burgerGoesToAna ? 3000 : 1000)],
        unclaimed_item_ids: ['burger'],
        unclaimed_cents: 0,
      })
    }
    if (url.endsWith('/lock')) {
      if (lockResponse) return lockResponse()
      state.status = 'LOCKED'
      state.settlements = [row('ana', 'Anna', 1000)]
      return jsonResponse(200, {})
    }
    if (url.endsWith('/reopen')) {
      if (actionResponse) return actionResponse()
      state.status = 'OPEN'
      state.settlements = []
      return jsonResponse(200, {})
    }
    if (url.endsWith('/mine/paid')) {
      if (actionResponse) return actionResponse()
      state.settlements = state.settlements.map((s) => ({ ...s, status: 'MARKED_PAID' }))
      return jsonResponse(200, state.settlements[0])
    }
    if (url.endsWith('/confirm')) {
      if (actionResponse) return actionResponse()
      state.settlements = state.settlements.map((s) => ({ ...s, status: 'CONFIRMED' }))
      state.status = 'SETTLED'
      return jsonResponse(200, state.settlements[0])
    }
    if (url.endsWith('/not-received')) {
      state.settlements = state.settlements.map((s) => ({ ...s, status: 'OWED' }))
      return jsonResponse(200, state.settlements[0])
    }
    if (url.endsWith('/settlements')) return jsonResponse(200, state.settlements)
    if (url.endsWith('/totals')) {
      return jsonResponse(200, {
        people: [personTotal('cap', 2000), personTotal('ana', 1000)],
        unclaimed_item_ids: state.status === 'OPEN' ? ['burger'] : [],
        unclaimed_cents: state.status === 'OPEN' ? 2000 : 0,
      })
    }
    return jsonResponse(200, {
      share_code: 'abc123',
      status: state.status,
      restaurant_name: "Luigi's",
      subtotal_cents: 3000,
      tax_cents: 0,
      tip_cents: 0,
      fees_cents: 0,
      total_cents: 3000,
      split_tip: true,
      venmo_handle: null,
      cashapp_tag: null,
      zelle_contact: null,
      ...handles,
      items: [
        { id: 'burger', description: 'Burger', price_cents: 2000, position: 0, claims: state.claims.burger },
        { id: 'salad', description: 'Salad', price_cents: 1000, position: 1, claims: state.claims.salad },
      ],
      crew: CREW,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetchMock }
}

function renderAs(crewMemberId: string | null, path: string) {
  if (crewMemberId) {
    localStorage.setItem(
      'dibs.identity.abc123',
      JSON.stringify({ crewMemberId, token: `${crewMemberId}-token` }),
    )
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function callsTo(fetchMock: Mock, ending: string) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith(ending))
}

const LOCK_PAGE = '/bills/abc123/lock'
const SHARE_PAGE = '/bills/abc123/share'
const CLAIMED_PAGE = '/b/abc123/claimed'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- The way in ---

test('the Captain locks from the screen where everyone calls dibs', async () => {
  fakeApi()
  renderAs('cap', '/b/abc123')

  expect(await screen.findByRole('link', { name: 'Lock bill' })).toHaveAttribute('href', LOCK_PAGE)
})

test('the Captain can also lock from their confirmation screen', async () => {
  fakeApi()
  renderAs('cap', CLAIMED_PAGE)

  expect(await screen.findByRole('link', { name: 'Lock bill' })).toHaveAttribute('href', LOCK_PAGE)
})

test('the QR screen has no lock button', async () => {
  fakeApi()
  renderAs('cap', SHARE_PAGE)

  await screen.findByText('Unclaimed')

  expect(screen.queryByRole('link', { name: 'Lock bill' })).not.toBeInTheDocument()
})

test('unsaved picks come first, so locking cannot lose them', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('cap', '/b/abc123')

  await user.click(await screen.findByRole('button', { name: /Burger/ }))

  expect(screen.queryByRole('link', { name: 'Lock bill' })).not.toBeInTheDocument()
  expect(screen.getByText('Call dibs on your picks before you lock the bill.')).toBeInTheDocument()
})

test('crew never get a lock link', async () => {
  fakeApi()
  renderAs('ana', '/b/abc123')

  await screen.findByRole('button', { name: /Burger/ })

  expect(screen.queryByRole('link', { name: 'Lock bill' })).not.toBeInTheDocument()
})

test('a locked bill has no lock link', async () => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('cap', '/b/abc123')

  await screen.findByRole('link', { name: 'See what you owe' })

  expect(screen.queryByRole('link', { name: 'Lock bill' })).not.toBeInTheDocument()
})

test('Not yet goes back to where everyone calls dibs', async () => {
  fakeApi()
  renderAs('cap', LOCK_PAGE)

  expect(await screen.findByRole('link', { name: 'Not yet' })).toHaveAttribute('href', '/b/abc123')
})

// --- The lock page ---

test('shows unclaimed items first and the final amounts from the API', async () => {
  fakeApi()
  renderAs('cap', LOCK_PAGE)

  expect(await screen.findByRole('heading', { name: '1 item has no dibs' })).toBeInTheDocument()
  expect(screen.getByLabelText(/Burger/)).toHaveValue('cap')
  expect(await screen.findByText('Brandon (you)', { selector: 'li span' })).toBeInTheDocument()
  expect(screen.getByText('$20.00', { selector: 'li span' })).toBeInTheDocument()
})

test('Lock bill stays off until unclaimed items are confirmed', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('cap', LOCK_PAGE)
  await screen.findByText('$20.00', { selector: 'li span' })
  const lock = screen.getByRole('button', { name: 'Lock bill' })
  expect(lock).toBeDisabled()

  await user.click(screen.getByLabelText("I've checked who gets the unclaimed items."))

  expect(lock).toBeEnabled()
  expect(callsTo(fetchMock, '/lock')).toHaveLength(0)
})

test('giving an item to someone updates the amounts and goes with the lock', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('cap', LOCK_PAGE)

  await user.selectOptions(await screen.findByLabelText(/Burger/), 'Anna')

  expect(await screen.findByText('$30.00', { selector: 'li span' })).toBeInTheDocument()
  await user.click(screen.getByLabelText("I've checked who gets the unclaimed items."))
  await user.click(screen.getByRole('button', { name: 'Lock bill' }))

  await screen.findByRole('heading', { name: "Who's paid" })
  const [, init] = callsTo(fetchMock, '/lock')[0]
  expect(init.headers.Authorization).toBe('Bearer cap-token')
  expect(JSON.parse(init.body)).toEqual({ assignments: { burger: 'ana' } })
})

test('keeping an item leaves it out, so it goes to the Captain', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('cap', LOCK_PAGE)
  await screen.findByText('$20.00', { selector: 'li span' })

  await user.click(screen.getByLabelText("I've checked who gets the unclaimed items."))
  await user.click(screen.getByRole('button', { name: 'Lock bill' }))

  await screen.findByRole('heading', { name: "Who's paid" })
  expect(JSON.parse(callsTo(fetchMock, '/lock')[0][1].body)).toEqual({ assignments: {} })
})

test('with everything claimed, there is nothing to confirm', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'cap', shares: 1 }]
  renderAs('cap', LOCK_PAGE)

  expect(await screen.findByText('Every item has been claimed.')).toBeInTheDocument()
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Lock bill' })).toBeEnabled())
})

test('a refused lock shows why and stays on the page', async () => {
  const user = userEvent.setup()
  fakeApi({ lockResponse: () => jsonResponse(409, { detail: 'Someone just claimed one of those items.' }) })
  renderAs('cap', LOCK_PAGE)
  await screen.findByText('$20.00', { selector: 'li span' })

  await user.click(screen.getByLabelText("I've checked who gets the unclaimed items."))
  await user.click(screen.getByRole('button', { name: 'Lock bill' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Someone just claimed')
  expect(screen.getByRole('heading', { name: 'Lock this bill' })).toBeInTheDocument()
})

test('a second tap on Lock bill does not lock twice', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const { fetchMock } = fakeApi({
    lockResponse: () => new Promise((resolve) => (finish = resolve)),
  })
  renderAs('cap', LOCK_PAGE)
  await screen.findByText('$20.00', { selector: 'li span' })

  await user.click(screen.getByLabelText("I've checked who gets the unclaimed items."))
  await user.click(screen.getByRole('button', { name: 'Lock bill' }))
  const locking = await screen.findByRole('button', { name: 'Locking…' })
  expect(locking).toBeDisabled()
  await user.click(locking)

  expect(callsTo(fetchMock, '/lock')).toHaveLength(1)
  finish(jsonResponse(200, {}))
})

test.each([
  ['crew', 'ana'],
  ['a visitor', null],
])('%s cannot use the lock page', async (_who, person) => {
  const { fetchMock } = fakeApi()
  renderAs(person, LOCK_PAGE)

  expect(
    await screen.findByRole('heading', { name: 'Only the Captain can lock this bill' }),
  ).toBeInTheDocument()
  expect(callsTo(fetchMock, '/lock/preview')).toHaveLength(0)
})

test('an already locked bill goes straight to who has paid', async () => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('cap', LOCK_PAGE)

  expect(await screen.findByRole('heading', { name: "Who's paid" })).toBeInTheDocument()
})

// --- The crew pay ---

test('after the lock, crew see their final amount, pay links and no warning', async () => {
  const { state } = fakeApi({
    status: 'LOCKED',
    settlements: [row('ana', 'Anna', 1856)],
    handles: { venmo_handle: '@brandon', cashapp_tag: '$brandon', zelle_contact: '555-0100' },
  })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', CLAIMED_PAGE)

  expect(await screen.findByRole('link', { name: '@brandon' })).toHaveAttribute(
    'href',
    "https://venmo.com/brandon?txn=pay&amount=18.56&note=Luigi's",
  )
  expect(screen.getByRole('link', { name: '$brandon' })).toHaveAttribute(
    'href',
    'https://cash.app/$brandon/18.56',
  )
  expect(screen.getByText('555-0100')).toBeInTheDocument()
  expect((await screen.findByRole('heading', { name: 'You owe' })).nextSibling).toHaveTextContent(
    '$18.56',
  )
  expect(screen.queryByText(/may change/)).not.toBeInTheDocument()
})

test('before the lock, payment details are plain text, with no links to pay', async () => {
  const { state } = fakeApi({ handles: { venmo_handle: '@brandon' } })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', CLAIMED_PAGE)

  expect(await screen.findByText('@brandon')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '@brandon' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'I paid' })).not.toBeInTheDocument()
})

test('I paid tells the Captain and waits for them to confirm', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi({
    status: 'LOCKED',
    settlements: [row('ana', 'Anna', 1000)],
  })
  state.claims.salad = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', CLAIMED_PAGE)

  await user.click(await screen.findByRole('button', { name: 'I paid' }))

  expect(await screen.findByText('Waiting for Brandon to confirm.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'I paid' })).not.toBeInTheDocument()
  expect(callsTo(fetchMock, '/settlements/mine/paid')[0][1].headers.Authorization).toBe(
    'Bearer ana-token',
  )
})

test('a confirmed payment says so', async () => {
  fakeApi({ status: 'SETTLED', settlements: [row('ana', 'Anna', 1000, 'CONFIRMED')] })
  renderAs('ana', CLAIMED_PAGE)

  expect(await screen.findByText('Brandon confirmed your payment.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'I paid' })).not.toBeInTheDocument()
})

test('a failed I paid shows why and can be tried again', async () => {
  const user = userEvent.setup()
  fakeApi({
    status: 'LOCKED',
    settlements: [row('ana', 'Anna', 1000)],
    actionResponse: () => jsonResponse(500, { detail: 'broken' }),
  })
  renderAs('ana', CLAIMED_PAGE)

  await user.click(await screen.findByRole('button', { name: 'I paid' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('broken')
  expect(screen.getByRole('button', { name: 'I paid' })).toBeEnabled()
})

test('someone who owes nothing after the lock is told so', async () => {
  fakeApi({ status: 'LOCKED', settlements: [] })
  renderAs('ana', CLAIMED_PAGE)

  expect(await screen.findByText("You don't owe anything on this bill.")).toBeInTheDocument()
})

test('the claim screen points to what you owe once a bill is locked', async () => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('ana', '/b/abc123')

  expect(await screen.findByRole('link', { name: 'See what you owe' })).toHaveAttribute(
    'href',
    CLAIMED_PAGE,
  )
})

// --- The Captain confirms ---

test('the Captain sees who has paid and can confirm it', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi({
    status: 'LOCKED',
    settlements: [row('ana', 'Anna', 1856, 'MARKED_PAID')],
  })
  renderAs('cap', SHARE_PAGE)

  const anna = (await screen.findByText('Anna')).closest('li')!
  expect(within(anna).getByText('$18.56')).toBeInTheDocument()
  expect(within(anna).getByText('Says they paid')).toBeInTheDocument()
  await user.click(within(anna).getByRole('button', { name: 'Got it' }))

  expect(await screen.findByText("Everyone's paid. This bill is settled.")).toBeInTheDocument()
  const [url, init] = callsTo(fetchMock, '/confirm')[0]
  expect(url).toBe('/api/bills/abc123/settlements/s-ana/confirm')
  expect(init.headers.Authorization).toBe('Bearer cap-token')
})

test('the Captain can say the money did not arrive', async () => {
  const user = userEvent.setup()
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000, 'MARKED_PAID')] })
  renderAs('cap', SHARE_PAGE)

  await user.click(await screen.findByRole('button', { name: 'Not received' }))

  expect(await screen.findByText('Owes you')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Not received' })).not.toBeInTheDocument()
})

test('the Captain can confirm someone who never tapped I paid', async () => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('cap', SHARE_PAGE)

  expect(await screen.findByRole('button', { name: 'Got it' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Not received' })).not.toBeInTheDocument()
})

test('a confirmed payment has nothing left to do', async () => {
  fakeApi({
    status: 'LOCKED',
    settlements: [row('ana', 'Anna', 1000, 'CONFIRMED'), row('ben', 'Ben', 500)],
  })
  renderAs('cap', SHARE_PAGE)

  const anna = (await screen.findByText('Anna')).closest('li')!

  expect(within(anna).getByText('Paid')).toBeInTheDocument()
  expect(within(anna).queryByRole('button')).not.toBeInTheDocument()
})

test.each([
  ['crew', 'ana'],
  ['a visitor', null],
])('%s can see who has paid but not change it', async (_who, person) => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000, 'MARKED_PAID')] })
  renderAs(person, SHARE_PAGE)

  await screen.findByText('Says they paid')

  expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reopen bill' })).not.toBeInTheDocument()
})

// --- Reopening ---

test('reopening asks first, then opens the bill again', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('cap', SHARE_PAGE)

  await user.click(await screen.findByRole('button', { name: 'Reopen bill' }))
  expect(callsTo(fetchMock, '/reopen')).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: 'Yes, reopen it' }))

  expect(await screen.findByRole('heading', { name: 'Have everyone scan this' })).toBeInTheDocument()
  expect(callsTo(fetchMock, '/reopen')).toHaveLength(1)
})

test('changing your mind about reopening does nothing', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000)] })
  renderAs('cap', SHARE_PAGE)

  await user.click(await screen.findByRole('button', { name: 'Reopen bill' }))
  await user.click(screen.getByRole('button', { name: 'Keep it locked' }))

  expect(screen.getByRole('button', { name: 'Reopen bill' })).toBeInTheDocument()
  expect(callsTo(fetchMock, '/reopen')).toHaveLength(0)
})

test('reopening is not offered once someone has paid', async () => {
  fakeApi({ status: 'LOCKED', settlements: [row('ana', 'Anna', 1000, 'MARKED_PAID')] })
  renderAs('cap', SHARE_PAGE)

  await screen.findByText('Says they paid')

  expect(screen.queryByRole('button', { name: 'Reopen bill' })).not.toBeInTheDocument()
})
