import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, type Mock, test, vi } from 'vitest'
import App from '../App.tsx'

type Claim = { crew_member_id: string; shares: number }

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

// Like the real API, a 204 has no body to read.
const NO_CONTENT = {
  ok: true,
  status: 204,
  json: async () => {
    throw new SyntaxError('Unexpected end of JSON input')
  },
}

// A small stand-in for the API that remembers claims, so tests see the page respond to them.
function fakeApi({
  status = 'OPEN',
  claimResponse,
  totalsResponse,
}: {
  status?: string
  claimResponse?: () => unknown
  totalsResponse?: () => unknown
} = {}) {
  const state = {
    status,
    claims: { burger: [], salad: [] } as Record<string, Claim[]>,
  }
  const items = [
    { id: 'burger', description: 'Burger', price_cents: 2000 },
    { id: 'salad', description: 'Salad', price_cents: 1000 },
  ]
  const crew = [
    { id: 'cap', name: 'Brandon', is_captain: true },
    { id: 'ana', name: 'Ana', is_captain: false },
    { id: 'ben', name: 'Ben', is_captain: false },
  ]

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/items/')) {
      if (claimResponse) return claimResponse()
      const itemId = url.split('/')[3]
      const headers = init?.headers as Record<string, string>
      const me = headers.Authorization.replace('Bearer ', '')
      state.claims[itemId] = state.claims[itemId].filter((c) => c.crew_member_id !== me)
      if (method === 'DELETE') return NO_CONTENT
      state.claims[itemId].push({ crew_member_id: me, shares: 1 })
      return jsonResponse(200, { line_item_id: itemId, crew_member_id: me, shares: 1 })
    }
    if (url.endsWith('/totals')) {
      if (totalsResponse) return totalsResponse()
      return jsonResponse(200, {
        people: crew.map((person) => {
          const subtotal = items
            .filter((item) => state.claims[item.id].some((c) => c.crew_member_id === person.id))
            .reduce((sum, item) => sum + item.price_cents, 0)
          return {
            crew_member_id: person.id,
            name: person.name,
            claimed_cents: subtotal,
            unclaimed_cents: 0,
            subtotal_cents: subtotal,
            tax_cents: 7,
            tip_cents: 11,
            fees_cents: 0,
            total_cents: subtotal + 18,
          }
        }),
        unclaimed_item_ids: items
          .filter((item) => state.claims[item.id].length === 0)
          .map((item) => item.id),
      })
    }
    return jsonResponse(200, {
      share_code: 'abc123',
      status: state.status,
      restaurant_name: "Luigi's",
      subtotal_cents: 3000,
      tax_cents: 240,
      tip_cents: 600,
      fees_cents: 0,
      total_cents: 3840,
      split_tip: true,
      items: items.map((item, position) => ({
        ...item,
        position,
        claims: state.claims[item.id],
      })),
      crew,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetchMock }
}

function renderAs(crewMemberId: string) {
  // The fake API uses the token to know who's asking, so token and crew id match here.
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId, token: crewMemberId }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/b/abc123']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function claimCalls(fetchMock: Mock) {
  return fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/items/'))
}

function itemButton(name: RegExp) {
  return screen.findByRole('button', { name })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('items start unclaimed, and tapping one calls dibs with your token', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('ana')

  const burger = await itemButton(/Burger/)
  expect(burger).toHaveAttribute('aria-pressed', 'false')
  await user.click(burger)

  expect(await itemButton(/Burger.*You/)).toHaveAttribute('aria-pressed', 'true')
  const [url, init] = claimCalls(fetchMock)[0]
  expect(url).toBe('/api/items/burger/claim')
  expect(init.method).toBe('PUT')
  expect(init.headers.Authorization).toBe('Bearer ana')
  expect(JSON.parse(init.body)).toEqual({ shares: 1 })
})

test('tapping a claimed item drops it, and the empty 204 response is fine', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana')

  await user.click(await itemButton(/Burger.*You/))

  expect(await itemButton(/^Burger\$20\.00$/)).toHaveAttribute('aria-pressed', 'false')
  const [url, init] = claimCalls(fetchMock)[0]
  expect(url).toBe('/api/items/burger/claim')
  expect(init.method).toBe('DELETE')
  expect(init.headers.Authorization).toBe('Bearer ana')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('shows who is at the table under the instructions, above the items', async () => {
  fakeApi()
  renderAs('ana')

  const burger = await itemButton(/Burger/)
  const table = screen.getByText('At the table: Brandon, Ana, Ben')
  const instructions = screen.getByText('Tap what you had. Tap it again to drop it.')

  expect(instructions.compareDocumentPosition(table)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(table.compareDocumentPosition(burger)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

test('shows who is on each item in plain words', async () => {
  const { state } = fakeApi()
  state.claims.burger = [
    { crew_member_id: 'ben', shares: 1 },
    { crew_member_id: 'ana', shares: 1 },
  ]
  state.claims.salad = [
    { crew_member_id: 'ben', shares: 1 },
    { crew_member_id: 'cap', shares: 1 },
  ]
  renderAs('ana')

  expect(await itemButton(/Burger/)).toHaveTextContent('You + Ben')
  expect(await itemButton(/Salad/)).toHaveTextContent('Ben + Brandon')
  expect(await itemButton(/Salad/)).toHaveAttribute('aria-pressed', 'false')
})

test.each([
  ['crew', 'ana', 'You owe'],
  ['Captain', 'cap', 'Your total'],
])('never uses the word share on screen for the %s', async (_role, person, heading) => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: person, shares: 2 }]
  renderAs(person)

  await itemButton(/Burger/)
  await screen.findByText(heading)

  expect(document.body.textContent).not.toMatch(/share/i)
})

test('your total comes from the API and changes when you claim something', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('ana')

  expect(await screen.findByText('$0.18')).toBeInTheDocument()
  await user.click(await itemButton(/Burger/))

  expect(await screen.findByText('$20.18')).toBeInTheDocument()
  expect(screen.getByText('Your items').nextSibling).toHaveTextContent('$20.00')
  expect(screen.getByText('Your tax').nextSibling).toHaveTextContent('$0.07')
  expect(screen.getByText('Your tip').nextSibling).toHaveTextContent('$0.11')
})

test('shows your part of the fees when there are some', async () => {
  fakeApi({
    totalsResponse: () =>
      jsonResponse(200, {
        people: [
          {
            crew_member_id: 'ana',
            name: 'Ana',
            claimed_cents: 1000,
            unclaimed_cents: 0,
            subtotal_cents: 1000,
            tax_cents: 0,
            tip_cents: 0,
            fees_cents: 31,
            total_cents: 1031,
          },
        ],
        unclaimed_item_ids: [],
      }),
  })
  renderAs('ana')

  expect((await screen.findByText('Your fees')).nextSibling).toHaveTextContent('$0.31')
})

test('the Captain sees unclaimed items apart from what they claimed', async () => {
  fakeApi({
    totalsResponse: () =>
      jsonResponse(200, {
        people: [
          {
            crew_member_id: 'cap',
            name: 'Brandon',
            claimed_cents: 1400,
            unclaimed_cents: 8950,
            subtotal_cents: 10350,
            tax_cents: 725,
            tip_cents: 0,
            fees_cents: 311,
            total_cents: 11386,
          },
        ],
        unclaimed_item_ids: ['burger'],
      }),
  })
  renderAs('cap')

  expect((await screen.findByText('Your items')).nextSibling).toHaveTextContent('$14.00')
  expect(screen.getByText('Unclaimed, counts as yours').nextSibling).toHaveTextContent('$89.50')
  expect(screen.getByRole('heading', { name: 'Your total' }).nextSibling).toHaveTextContent(
    '$113.86',
  )
})

test('nobody sees an unclaimed row when they have none', async () => {
  fakeApi()
  renderAs('ana')

  await screen.findByText('Your items')

  expect(screen.queryByText('Unclaimed, counts as yours')).not.toBeInTheDocument()
})

test('crew are told what they owe, and the bill total stays visible', async () => {
  fakeApi()
  renderAs('ana')

  expect(await screen.findByRole('heading', { name: 'You owe' })).toBeInTheDocument()
  expect(screen.getByText('Total').nextSibling).toHaveTextContent('$38.40')
})

test('the Captain sees their total and is warned about unclaimed items', async () => {
  fakeApi()
  renderAs('cap')

  expect(await screen.findByRole('heading', { name: 'Your total' })).toBeInTheDocument()
  expect(screen.getByText(/2 items have no dibs yet/)).toHaveTextContent(
    'Anything left unclaimed counts as yours.',
  )
})

test('crew see how many items are unclaimed, without the Captain warning', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ben', shares: 1 }]
  renderAs('ana')

  const notice = await screen.findByText(/1 item has no dibs yet/)
  expect(notice).not.toHaveTextContent('counts as yours')
})

test('a second tap while saving does not send a second request', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const { fetchMock } = fakeApi({
    claimResponse: () => new Promise((resolve) => (finish = resolve)),
  })
  renderAs('ana')

  const burger = await itemButton(/Burger/)
  await user.click(burger)
  expect(burger).toBeDisabled()
  await user.click(burger)

  expect(claimCalls(fetchMock)).toHaveLength(1)
  finish(jsonResponse(200, {}))
})

test('other items can be tapped while one is still saving', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const { fetchMock } = fakeApi({
    claimResponse: () => new Promise((resolve) => (finish = resolve)),
  })
  renderAs('ana')

  await user.click(await itemButton(/Burger/))
  const salad = await itemButton(/Salad/)
  expect(salad).toBeEnabled()
  await user.click(salad)

  expect(claimCalls(fetchMock)).toHaveLength(2)
  finish(jsonResponse(200, {}))
})

test('a failed claim shows an error and the item stays unclaimed', async () => {
  const user = userEvent.setup()
  fakeApi({ claimResponse: () => jsonResponse(500, { detail: 'server error' }) })
  renderAs('ana')

  await user.click(await itemButton(/Burger/))

  expect(await screen.findByRole('alert')).toHaveTextContent('server error')
  expect(await itemButton(/Burger/)).toHaveAttribute('aria-pressed', 'false')
  expect(await itemButton(/Burger/)).toBeEnabled()
})

test('if the bill locks just as you tap, the page shows it is locked', async () => {
  const user = userEvent.setup()
  const { state } = fakeApi({
    claimResponse: () => {
      state.status = 'LOCKED'
      return jsonResponse(409, { detail: 'bill is not open' })
    },
  })
  renderAs('ana')

  await user.click(await itemButton(/Burger/))

  expect(await screen.findByText('This bill is locked, so claims are final.')).toBeInTheDocument()
  expect(await itemButton(/Burger/)).toBeDisabled()
})

test('on a locked bill you can see your total but not change claims', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi({ status: 'LOCKED' })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana')

  const burger = await itemButton(/Burger/)
  expect(burger).toBeDisabled()
  expect(burger).toHaveAttribute('aria-pressed', 'true')
  await user.click(burger)

  expect(await screen.findByText('$20.18')).toBeInTheDocument()
  expect(claimCalls(fetchMock)).toHaveLength(0)
})

test('a failed total shows an error and can be tried again', async () => {
  const user = userEvent.setup()
  let healthy = false
  fakeApi({
    totalsResponse: () =>
      healthy
        ? jsonResponse(200, {
            people: [
              {
                crew_member_id: 'ana',
                name: 'Ana',
                claimed_cents: 0,
                unclaimed_cents: 0,
                subtotal_cents: 0,
                tax_cents: 0,
                tip_cents: 0,
                fees_cents: 0,
                total_cents: 42,
              },
            ],
            unclaimed_item_ids: [],
          })
        : jsonResponse(500, { detail: 'totals are broken' }),
  })
  renderAs('ana')

  expect(await screen.findByRole('alert')).toHaveTextContent('totals are broken')
  expect(await itemButton(/Burger/)).toBeEnabled()
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByText('$0.42')).toBeInTheDocument()
})

test('Refresh picks up what other people claimed', async () => {
  const user = userEvent.setup()
  const { state } = fakeApi()
  renderAs('ana')
  await itemButton(/Burger/)
  await screen.findByText('You owe')

  state.claims.salad = [{ crew_member_id: 'ben', shares: 1 }]
  await user.click(screen.getByRole('button', { name: 'Refresh' }))

  expect(await itemButton(/Salad.*Ben/)).toBeInTheDocument()
  expect(await screen.findByText(/1 item has no dibs yet/)).toBeInTheDocument()
})

test('someone who has not joined gets a plain list, with nothing to tap', async () => {
  const { fetchMock } = fakeApi()
  renderAs('not-on-this-bill')

  const list = (await screen.findByText('Burger')).closest('ul')!

  expect(within(list).queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/totals'))).toBe(false)
})
