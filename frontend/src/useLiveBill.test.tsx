import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App.tsx'
import { FakeWebSocket } from './testWebSocket.ts'

const BILL = {
  share_code: 'abc123',
  status: 'OPEN',
  restaurant_name: "Luigi's",
  subtotal_cents: 2000,
  tax_cents: 0,
  tip_cents: 0,
  fees_cents: 0,
  total_cents: 2000,
  split_tip: true,
  venmo_handle: null,
  cashapp_tag: null,
  zelle_contact: null,
  items: [{ id: 'burger', description: 'Burger', price_cents: 2000, position: 0, claims: [] }],
  crew: [
    { id: 'cap', name: 'Brandon', is_captain: true },
    { id: 'ana', name: 'Anna', is_captain: false },
  ],
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

function stubApi() {
  const state = { bill: BILL as typeof BILL & Record<string, unknown> }
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/totals')
      ? jsonResponse(200, { people: [], unclaimed_item_ids: [] })
      : jsonResponse(200, state.bill),
  )
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetchMock }
}

function renderBillPage(path = '/b/abc123') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function latestSocket() {
  return FakeWebSocket.instances.at(-1)!
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'ana', token: 'ana-token' }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('connects to the bill through the API path', async () => {
  stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })

  expect(latestSocket().url).toBe(`ws://${window.location.host}/api/bills/abc123/live`)
})

test('a change someone else made appears as soon as the server says so', async () => {
  const { state } = stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  act(() => latestSocket().open())

  state.bill = {
    ...BILL,
    items: [{ ...BILL.items[0], claims: [{ crew_member_id: 'cap', shares: 1 }] as never[] }],
  }
  act(() => latestSocket().receive())

  expect(await screen.findByRole('button', { name: /Claimed by Brandon/ })).toBeInTheDocument()
})

test('checks only rarely while connected', async () => {
  const { fetchMock } = stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  act(() => latestSocket().open())
  await act(() => vi.advanceTimersByTimeAsync(100))
  const callsWhenConnected = fetchMock.mock.calls.length

  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(fetchMock.mock.calls.length).toBe(callsWhenConnected)

  await act(() => vi.advanceTimersByTimeAsync(25_000))
  expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhenConnected)
})

test('falls back to frequent checks while disconnected', async () => {
  const { fetchMock } = stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  act(() => latestSocket().open())
  act(() => latestSocket().drop())
  const callsWhenDropped = fetchMock.mock.calls.length

  await act(() => vi.advanceTimersByTimeAsync(5000))

  expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhenDropped)
})

test('reconnects after a dropped connection, waiting longer each time', async () => {
  stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  expect(FakeWebSocket.instances).toHaveLength(1)

  act(() => latestSocket().drop())
  await act(() => vi.advanceTimersByTimeAsync(999))
  expect(FakeWebSocket.instances).toHaveLength(1)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(FakeWebSocket.instances).toHaveLength(2)

  act(() => latestSocket().drop())
  await act(() => vi.advanceTimersByTimeAsync(1999))
  expect(FakeWebSocket.instances).toHaveLength(2)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(FakeWebSocket.instances).toHaveLength(3)
})

test('the wait between attempts has a ceiling, and resets after connecting', async () => {
  stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })

  for (let attempt = 0; attempt < 8; attempt += 1) {
    act(() => latestSocket().drop())
    await act(() => vi.advanceTimersByTimeAsync(30_000))
  }
  const afterManyDrops = FakeWebSocket.instances.length
  expect(afterManyDrops).toBe(9)

  act(() => latestSocket().open())
  act(() => latestSocket().drop())
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(FakeWebSocket.instances).toHaveLength(afterManyDrops + 1)
})

test('catches up when it reconnects, in case it missed something', async () => {
  const { state } = stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  act(() => latestSocket().open())
  act(() => latestSocket().drop())

  state.bill = { ...BILL, crew: [...BILL.crew, { id: 'ben', name: 'Ben', is_captain: false }] }
  await act(() => vi.advanceTimersByTimeAsync(1000))
  act(() => latestSocket().open())

  expect(await screen.findByText('At the table: Brandon, Anna, Ben')).toBeInTheDocument()
})

test('stops trying when the server says the bill is not available', async () => {
  stubApi()
  renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })

  act(() => latestSocket().drop(4404))
  await act(() => vi.advanceTimersByTimeAsync(60_000))

  expect(FakeWebSocket.instances).toHaveLength(1)
})

test('leaving the page closes the connection and stops reconnecting', async () => {
  stubApi()
  const { unmount } = renderBillPage()
  await screen.findByRole('button', { name: /Burger/ })
  const socket = latestSocket()

  unmount()
  expect(socket.closed).toBe(true)
  socket.drop()
  await vi.advanceTimersByTimeAsync(60_000)

  expect(FakeWebSocket.instances).toHaveLength(1)
})

test('an update keeps what you have selected', async () => {
  vi.useRealTimers()
  stubApi()
  renderBillPage()
  const burger = await screen.findByRole('button', { name: /Burger/ })
  act(() => burger.click())
  act(() => latestSocket().open())

  act(() => latestSocket().receive())

  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: /Burger/ })).toHaveAttribute('aria-pressed', 'true'),
  )
})

test.each(['/bills/abc123/share', '/b/abc123/claimed'])('%s stays live too', async (path) => {
  stubApi()
  renderBillPage(path)

  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))

  expect(latestSocket().url).toContain('/api/bills/abc123/live')
})
