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

const ITEMS = [
  { id: 'burger', description: 'Burger', price_cents: 2000 },
  { id: 'salad', description: 'Salad', price_cents: 1000 },
  { id: 'fries', description: 'Funnel Cake Fries', price_cents: 1100 },
]
const CREW = [
  { id: 'cap', name: 'Brandon', is_captain: true },
  { id: 'ana', name: 'Anna', is_captain: false },
  { id: 'ben', name: 'Ben', is_captain: false },
]
const NO_CLAIMS = { burger: [], salad: [], fries: [] }

function personTotal(id: string, claims: Record<string, Claim[]>) {
  const person = CREW.find((member) => member.id === id)!
  const claimed = ITEMS.filter((item) =>
    claims[item.id].some((claim) => claim.crew_member_id === id),
  ).reduce((sum, item) => sum + item.price_cents, 0)
  const unclaimed = person.is_captain
    ? ITEMS.filter((item) => claims[item.id].length === 0).reduce(
        (sum, item) => sum + item.price_cents,
        0,
      )
    : 0
  return {
    crew_member_id: id,
    name: person.name,
    claimed_cents: claimed,
    unclaimed_cents: unclaimed,
    subtotal_cents: claimed + unclaimed,
    tax_cents: 7,
    tip_cents: 11,
    fees_cents: 0,
    total_cents: claimed + unclaimed + 18,
  }
}

// A small stand-in for the API that remembers claims, so tests see the pages respond to them.
function fakeApi({
  status = 'OPEN',
  saveResponse,
  previewResponse,
  totalsResponse,
  handles = {},
}: {
  status?: string
  saveResponse?: () => unknown
  previewResponse?: () => unknown
  totalsResponse?: () => unknown
  handles?: Record<string, string>
} = {}) {
  const state = {
    status,
    claims: { ...NO_CLAIMS } as Record<string, Claim[]>,
  }

  function applyPicks(claims: Record<string, Claim[]>, me: string, itemIds: string[]) {
    const next: Record<string, Claim[]> = {}
    for (const item of ITEMS) {
      const others = claims[item.id].filter((claim) => claim.crew_member_id !== me)
      next[item.id] = itemIds.includes(item.id)
        ? [...others, { crew_member_id: me, shares: 1 }]
        : others
    }
    return next
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const me = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(
      'Bearer ',
      '',
    )
    if (url.endsWith('/my-claims/preview')) {
      if (previewResponse) return previewResponse()
      const { item_ids: itemIds } = JSON.parse(init!.body as string)
      return jsonResponse(200, personTotal(me!, applyPicks(state.claims, me!, itemIds)))
    }
    if (url.endsWith('/my-claims')) {
      if (saveResponse) return saveResponse()
      const { item_ids: itemIds } = JSON.parse(init!.body as string)
      state.claims = applyPicks(state.claims, me!, itemIds)
      return jsonResponse(200, personTotal(me!, state.claims))
    }
    if (url.endsWith('/totals')) {
      if (totalsResponse) return totalsResponse()
      return jsonResponse(200, {
        people: CREW.map((person) => personTotal(person.id, state.claims)),
        unclaimed_item_ids: ITEMS.filter((item) => state.claims[item.id].length === 0).map(
          (item) => item.id,
        ),
      })
    }
    return jsonResponse(200, {
      share_code: 'abc123',
      status: state.status,
      restaurant_name: "Luigi's",
      subtotal_cents: 4100,
      tax_cents: 240,
      tip_cents: 600,
      fees_cents: 0,
      total_cents: 4940,
      split_tip: true,
      venmo_handle: null,
      cashapp_tag: null,
      zelle_contact: null,
      ...handles,
      items: ITEMS.map((item, position) => ({
        ...item,
        position,
        claims: state.claims[item.id],
      })),
      crew: CREW,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetchMock }
}

function renderPage(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderAs(crewMemberId: string, path = '/b/abc123') {
  // The fake API uses the token to know who's asking, so token and crew id match here.
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId, token: crewMemberId }),
  )
  renderPage(path)
}

function callsTo(fetchMock: Mock, ending: string) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith(ending))
}

function item(name: RegExp) {
  return screen.findByRole('button', { name })
}

function callDibs() {
  return screen.getByRole('button', { name: 'Call dibs' })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// --- Picking items ---

test('tapping only selects: nothing is saved until you confirm', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('ana')

  const burger = await item(/Burger/)
  expect(burger).toHaveAttribute('aria-pressed', 'false')
  await user.click(burger)

  expect(burger).toHaveAttribute('aria-pressed', 'true')
  expect(burger).toHaveTextContent('You')
  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(0)
})

test('tapping again deselects, and Call dibs is off with nothing to change', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('ana')

  const burger = await item(/Burger/)
  expect(callDibs()).toBeDisabled()
  await user.click(burger)
  expect(callDibs()).toBeEnabled()
  await user.click(burger)

  expect(burger).toHaveAttribute('aria-pressed', 'false')
  expect(callDibs()).toBeDisabled()
})

test('shows who has claimed each item, with the option to share it', async () => {
  const { state } = fakeApi()
  state.claims.fries = [{ crew_member_id: 'ana', shares: 1 }]
  state.claims.salad = [
    { crew_member_id: 'ana', shares: 1 },
    { crew_member_id: 'ben', shares: 1 },
  ]
  renderAs('cap')

  const fries = await item(/Funnel Cake Fries/)
  expect(fries).toHaveTextContent('Claimed by Anna')
  expect(fries).toHaveTextContent('Tap to share it')
  expect(await item(/Salad/)).toHaveTextContent('Claimed by Anna and Ben')
  expect(await item(/Burger/)).not.toHaveTextContent('Claimed by')
})

test('selecting an item someone else claimed shows you are sharing it', async () => {
  const user = userEvent.setup()
  const { state } = fakeApi()
  state.claims.fries = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ben')

  const fries = await item(/Funnel Cake Fries/)
  await user.click(fries)

  expect(fries).toHaveTextContent('You + Anna')
  expect(fries).not.toHaveTextContent('Tap to share it')
})

test('what you already claimed starts selected', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana')

  expect(await item(/Burger/)).toHaveAttribute('aria-pressed', 'true')
  expect(callDibs()).toBeDisabled()
  expect(screen.getByRole('link', { name: 'See what you claimed' })).toHaveAttribute(
    'href',
    '/b/abc123/claimed',
  )
})

test('other people claiming things appears on its own and keeps your selections', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const { state } = fakeApi()
  renderAs('ben')
  await user.click(await item(/Burger/))

  state.claims.fries = [{ crew_member_id: 'ana', shares: 1 }]
  await vi.advanceTimersByTimeAsync(5000)

  expect(await item(/Funnel Cake Fries.*Claimed by Anna/)).toBeInTheDocument()
  expect(await item(/Burger/)).toHaveAttribute('aria-pressed', 'true')
})

test('a failed background check keeps your selections', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const { fetchMock } = fakeApi()
  renderAs('ben')
  await user.click(await item(/Burger/))

  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  await vi.advanceTimersByTimeAsync(5000)

  expect(screen.getByRole('button', { name: /Burger/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('your total follows what you select, before anything is saved', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi()
  renderAs('ana')
  expect((await screen.findByText('Your items')).nextSibling).toHaveTextContent('$0.00')

  await user.click(await item(/Burger/))
  expect(await screen.findByText('$20.18')).toBeInTheDocument()
  await user.click(await item(/Salad/))
  expect(await screen.findByText('$30.18')).toBeInTheDocument()

  expect(screen.getByText('Not saved yet. Call dibs to lock in your items.')).toBeInTheDocument()
  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(0)
  expect(state.claims.burger).toEqual([])
})

test('deselecting goes back to your saved total, and the note goes away', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('ana')
  const burger = await item(/Burger/)

  await user.click(burger)
  await screen.findByText('$20.18')
  await user.click(burger)

  expect(await screen.findByText('$0.18')).toBeInTheDocument()
  expect(screen.queryByText(/Not saved yet/)).not.toBeInTheDocument()
})

test('the Captain total moves from unclaimed to their items as they select', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('cap')
  expect((await screen.findByText('Unclaimed, counts as yours')).nextSibling).toHaveTextContent(
    '$41.00',
  )
  expect(screen.getByText(/3 items have no dibs yet/)).toBeInTheDocument()

  await user.click(await item(/Burger/))

  await vi.waitFor(() =>
    expect(screen.getByText('Your items').nextSibling).toHaveTextContent('$20.00'),
  )
  expect(screen.getByText('Unclaimed, counts as yours').nextSibling).toHaveTextContent('$21.00')
  expect(screen.getByText(/2 items have no dibs yet/)).toBeInTheDocument()
})

test('the same items in any order use the same preview', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('ana')

  await user.click(await item(/Salad/))
  await screen.findByText('$10.18')
  await user.click(await item(/Burger/))
  await screen.findByText('$30.18')

  const sent = callsTo(fetchMock, '/my-claims/preview').map(([, init]) => JSON.parse(init.body).item_ids)
  expect(sent.at(-1)).toEqual(['burger', 'salad'])
})

test('a failed preview keeps the screen usable and says the total may be off', async () => {
  const user = userEvent.setup()
  fakeApi({ previewResponse: () => jsonResponse(500, { detail: 'broken' }) })
  renderAs('ana')

  await user.click(await item(/Burger/))

  expect(await screen.findByText(/Couldn't update this total/)).toBeInTheDocument()
  expect(await item(/Burger/)).toBeEnabled()
  expect(callDibs()).toBeEnabled()
})

test('someone else sharing your selected item updates your preview', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const { fetchMock } = fakeApi()
  renderAs('ana')
  await user.click(await item(/Burger/))
  await screen.findByText('$20.18')
  const previewsSoFar = callsTo(fetchMock, '/my-claims/preview').length

  await vi.advanceTimersByTimeAsync(5000)

  expect(callsTo(fetchMock, '/my-claims/preview').length).toBeGreaterThan(previewsSoFar)
})

test('never shows a number of shares on the claim screen', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'cap', shares: 2 }]
  renderAs('cap')

  await screen.findByText('Your total')

  expect(document.body.textContent).not.toMatch(/\bshares\b/i)
})

test('on a locked bill you can see your total but not change anything', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi({ status: 'LOCKED' })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana')

  const burger = await item(/Burger/)
  expect(burger).toBeDisabled()
  expect(burger).toHaveAttribute('aria-pressed', 'true')
  await user.click(burger)

  expect(await screen.findByText('$20.18')).toBeInTheDocument()
  expect(screen.getByText('This bill is locked, so claims are final.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Call dibs' })).not.toBeInTheDocument()
  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(0)
})

test('someone who has not joined gets a plain list, with nothing to tap', async () => {
  const { fetchMock } = fakeApi()
  renderAs('not-on-this-bill')

  const list = (await screen.findByText('Burger')).closest('ul')!

  expect(within(list).queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument()
  expect(callsTo(fetchMock, '/totals')).toHaveLength(0)
})

// --- The modal ---

test('the modal lists your items and the total from the API', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi()
  state.claims.fries = [{ crew_member_id: 'ben', shares: 1 }]
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(await item(/Funnel Cake Fries/))
  await user.click(callDibs())

  const modal = await screen.findByRole('dialog', { name: 'Confirm your dibs' })
  expect(within(modal).getByText('Burger')).toBeInTheDocument()
  expect(within(modal).getByText('Funnel Cake Fries')).toBeInTheDocument()
  expect(within(modal).getByText('Shared with Ben')).toBeInTheDocument()
  expect(within(modal).queryByText('Salad')).not.toBeInTheDocument()
  expect(await within(modal).findByText('$31.18')).toBeInTheDocument()

  const [, init] = callsTo(fetchMock, '/my-claims/preview').at(-1)!
  expect(init.method).toBe('POST')
  expect(init.headers.Authorization).toBe('Bearer ana')
  expect(JSON.parse(init.body).item_ids).toEqual(['burger', 'fries'])
  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(0)
})

test('confirming saves everything in one request and opens the confirmation screen', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi()
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(await item(/Salad/))
  await user.click(callDibs())
  const modal = await screen.findByRole('dialog')
  await within(modal).findByText('$30.18')
  await user.click(within(modal).getByRole('button', { name: 'Confirm' }))

  expect(await screen.findByRole('heading', { name: 'You called dibs!' })).toBeInTheDocument()
  expect(screen.getByText('You claimed Burger and Salad.')).toBeInTheDocument()
  const saves = callsTo(fetchMock, '/my-claims')
  expect(saves).toHaveLength(1)
  expect(saves[0][1].method).toBe('PUT')
  expect(saves[0][1].headers.Authorization).toBe('Bearer ana')
  expect(JSON.parse(saves[0][1].body).item_ids.sort()).toEqual(['burger', 'salad'])
  expect(state.claims.burger).toEqual([{ crew_member_id: 'ana', shares: 1 }])
})

test('Go back closes the modal, keeps your selections and saves nothing', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())
  await user.click(await screen.findByRole('button', { name: 'Go back' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(await item(/Burger/)).toHaveAttribute('aria-pressed', 'true')
  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(0)
})

test('Escape closes the modal too, and focus starts inside it', async () => {
  const user = userEvent.setup()
  fakeApi()
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())
  const modal = await screen.findByRole('dialog')
  expect(modal).toHaveFocus()
  await user.keyboard('{Escape}')

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('Confirm waits for the total', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  fakeApi({ previewResponse: () => new Promise((resolve) => (finish = resolve)) })
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())

  const confirm = await screen.findByRole('button', { name: 'Confirm' })
  expect(confirm).toBeDisabled()
  expect(within(screen.getByRole('dialog')).getByText('Working out your total…')).toBeInTheDocument()
  finish(jsonResponse(200, personTotal('ana', NO_CLAIMS)))
  await vi.waitFor(() => expect(confirm).toBeEnabled())
})

test('a failed preview can be tried again, and Confirm stays off', async () => {
  const user = userEvent.setup()
  let healthy = false
  fakeApi({
    previewResponse: () =>
      healthy
        ? jsonResponse(200, personTotal('ana', NO_CLAIMS))
        : jsonResponse(500, { detail: 'preview is broken' }),
  })
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())

  expect(await screen.findByRole('alert')).toHaveTextContent('preview is broken')
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled())
})

test('a failed save stays in the modal, shows why and saves nothing', async () => {
  const user = userEvent.setup()
  fakeApi({ saveResponse: () => jsonResponse(409, { detail: 'bill is not open' }) })
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())
  const confirm = await screen.findByRole('button', { name: 'Confirm' })
  await vi.waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)

  expect(await screen.findByRole('alert')).toHaveTextContent('bill is not open')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'You called dibs!' })).not.toBeInTheDocument()
})

test('a second tap on Confirm does not save twice', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const { fetchMock } = fakeApi({
    saveResponse: () => new Promise((resolve) => (finish = resolve)),
  })
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())
  const confirm = await screen.findByRole('button', { name: 'Confirm' })
  await vi.waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  const saving = await screen.findByRole('button', { name: 'Saving…' })
  expect(saving).toBeDisabled()
  await user.click(saving)

  expect(callsTo(fetchMock, '/my-claims')).toHaveLength(1)
  finish(jsonResponse(200, personTotal('ana', NO_CLAIMS)))
  await screen.findByRole('heading', { name: 'No dibs yet' })
})

test('dropping an item says so, and you can drop everything', async () => {
  const user = userEvent.setup()
  const { state, fetchMock } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana')

  await user.click(await item(/Burger/))
  await user.click(callDibs())

  const modal = await screen.findByRole('dialog')
  expect(within(modal).getByText("You won't have any items.")).toBeInTheDocument()
  expect(within(modal).getByText('Dropping: Burger')).toBeInTheDocument()
  const confirm = within(modal).getByRole('button', { name: 'Confirm' })
  await vi.waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)

  expect(await screen.findByRole('heading', { name: 'No dibs yet' })).toBeInTheDocument()
  expect(JSON.parse(callsTo(fetchMock, '/my-claims')[0][1].body).item_ids).toEqual([])
})

// --- The Captain's total ---

test('the Captain sees unclaimed items apart from what they claimed', async () => {
  const { state } = fakeApi()
  state.claims.salad = [{ crew_member_id: 'cap', shares: 1 }]
  renderAs('cap')

  expect((await screen.findByText('Your items')).nextSibling).toHaveTextContent('$10.00')
  expect(screen.getByText('Unclaimed, counts as yours').nextSibling).toHaveTextContent('$31.00')
  expect(screen.getByRole('heading', { name: 'Your total' })).toBeInTheDocument()
  expect(screen.getByText(/2 items have no dibs yet/)).toHaveTextContent(
    'Anything left unclaimed counts as yours.',
  )
})

test('crew see how many items are unclaimed, without the Captain warning', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ben', shares: 1 }]
  renderAs('ana')

  expect(await screen.findByRole('heading', { name: 'You owe' })).toBeInTheDocument()
  const notice = await screen.findByText(/2 items have no dibs yet/)
  expect(notice).not.toHaveTextContent('counts as yours')
  expect(screen.queryByText('Unclaimed, counts as yours')).not.toBeInTheDocument()
})

test('shows your part of the fees when there are some', async () => {
  fakeApi({
    totalsResponse: () =>
      jsonResponse(200, {
        people: [{ ...personTotal('ana', NO_CLAIMS), fees_cents: 31 }],
        unclaimed_item_ids: [],
      }),
  })
  renderAs('ana')

  expect((await screen.findByText('Your fees')).nextSibling).toHaveTextContent('$0.31')
})

test('a failed total shows an error and can be tried again', async () => {
  const user = userEvent.setup()
  let healthy = false
  fakeApi({
    totalsResponse: () =>
      healthy
        ? jsonResponse(200, { people: [personTotal('ana', NO_CLAIMS)], unclaimed_item_ids: [] })
        : jsonResponse(500, { detail: 'totals are broken' }),
  })
  renderAs('ana')

  expect(await screen.findByRole('alert')).toHaveTextContent('totals are broken')
  expect(await item(/Burger/)).toBeEnabled()
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByText('Your items')).toBeInTheDocument()
})

// --- The confirmation screen ---

test('lists what you claimed, what you owe and how to pay the Captain', async () => {
  const { state } = fakeApi({
    handles: { venmo_handle: '@brandon', cashapp_tag: '$brandon', zelle_contact: '555-0100' },
  })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  state.claims.fries = [
    { crew_member_id: 'ana', shares: 1 },
    { crew_member_id: 'ben', shares: 1 },
  ]
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByText('You claimed Burger and Funnel Cake Fries.')).toBeInTheDocument()
  expect(screen.getByText('Shared with Ben')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'You owe' })).toBeInTheDocument()
  expect(await screen.findByText('$31.18')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Pay Brandon' })).toBeInTheDocument()
  expect(screen.getByText('Venmo').nextSibling).toHaveTextContent('@brandon')
  expect(screen.getByText('Cash App').nextSibling).toHaveTextContent('$brandon')
  expect(screen.getByText('Zelle').nextSibling).toHaveTextContent('555-0100')
})

test('warns that the total may change until the bill is locked', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', '/b/abc123/claimed')

  expect(
    await screen.findByText(
      'Your total may change if someone shares your items. Wait for Brandon to confirm before paying.',
    ),
  ).toBeInTheDocument()
})

test('only shows the payment apps the Captain added', async () => {
  const { state } = fakeApi({ handles: { venmo_handle: '@brandon' } })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByText('Venmo')).toBeInTheDocument()
  expect(screen.queryByText('Cash App')).not.toBeInTheDocument()
  expect(screen.queryByText('Zelle')).not.toBeInTheDocument()
})

test('says so when the Captain added no payment info', async () => {
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByText(/Brandon hasn't added any payment info/)).toBeInTheDocument()
})

test('Change my items goes back with your items still selected', async () => {
  const user = userEvent.setup()
  const { state } = fakeApi()
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', '/b/abc123/claimed')

  await user.click(await screen.findByRole('link', { name: 'Change my items' }))

  expect(await item(/Burger/)).toHaveAttribute('aria-pressed', 'true')
})

test('the Captain has nobody to pay, and gets back to the QR code', async () => {
  const { state } = fakeApi({ handles: { venmo_handle: '@brandon' } })
  state.claims.burger = [{ crew_member_id: 'cap', shares: 1 }]
  renderAs('cap', '/b/abc123/claimed')

  expect(await screen.findByText('You claimed Burger.')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Your total' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Pay / })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Back to the QR code' })).toHaveAttribute(
    'href',
    '/bills/abc123/share',
  )
})

test('with nothing claimed there is nothing to pay', async () => {
  fakeApi({ handles: { venmo_handle: '@brandon' } })
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByRole('heading', { name: 'No dibs yet' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Pay / })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Pick my items' })).toHaveAttribute('href', '/b/abc123')
})

test('someone not on the bill is sent to join it', async () => {
  fakeApi()
  renderAs('not-on-this-bill', '/b/abc123/claimed')

  expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument()
})

test('someone with no saved identity is sent to join it', async () => {
  fakeApi()
  renderPage('/b/abc123/claimed')

  expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument()
})

test('on a locked bill, the warning and the way back to picking are gone', async () => {
  const { state } = fakeApi({ status: 'LOCKED', handles: { venmo_handle: '@brandon' } })
  state.claims.burger = [{ crew_member_id: 'ana', shares: 1 }]
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByText('Venmo')).toBeInTheDocument()
  expect(screen.queryByText(/may change/)).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Change my items' })).not.toBeInTheDocument()
})

test('a failed load can be tried again', async () => {
  const user = userEvent.setup()
  const { fetchMock } = fakeApi()
  const working = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/abc123')) throw new TypeError('Failed to fetch')
    return working(url)
  })
  renderAs('ana', '/b/abc123/claimed')

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
  fetchMock.mockImplementation(working)
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByRole('heading', { name: 'No dibs yet' })).toBeInTheDocument()
})
