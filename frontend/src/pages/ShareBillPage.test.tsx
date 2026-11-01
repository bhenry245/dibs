import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QRCodeSVG } from 'qrcode.react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import App from '../App.tsx'

const LINK = `${window.location.origin}/b/abc123`

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
    { id: 'burger', description: 'Burger', price_cents: 2000, position: 0, claims: [] },
    { id: 'nachos', description: 'Nachos', price_cents: 900, position: 1, claims: [] },
  ],
  crew: [
    { id: 'cap', name: 'Brandon', is_captain: true },
    { id: 'ana', name: 'Ana', is_captain: false },
  ],
}

function person(id: string, name: string, totalCents: number) {
  return {
    crew_member_id: id,
    name,
    subtotal_cents: 0,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: totalCents,
  }
}

const TOTALS = {
  people: [person('cap', 'Brandon', 3136), person('ana', 'Ana', 1856)],
  unclaimed_item_ids: [],
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

function stubApi(
  billResponse: () => unknown = () => jsonResponse(200, BILL),
  totalsResponse: () => unknown = () => jsonResponse(200, TOTALS),
) {
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/totals') ? totalsResponse() : billResponse(),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderSharePage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/bills/abc123/share']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function qrPaths(container: Element | null) {
  return [...(container?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d'))
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('the QR code encodes the link to join this bill', async () => {
  stubApi()
  renderSharePage()

  const qr = (await screen.findByTitle('QR code to join this bill')).closest('svg')

  // Same input draws the same squares, so compare with a QR made from the expected link.
  const expected = render(<QRCodeSVG value={LINK} marginSize={2} />)
  const different = render(<QRCodeSVG value={`${LINK}x`} marginSize={2} />)
  expect(qrPaths(qr)).toEqual(qrPaths(expected.container))
  expect(qrPaths(qr)).not.toEqual(qrPaths(different.container))
})

test('shows the link for anyone who can not scan', async () => {
  stubApi()
  renderSharePage()

  expect(await screen.findByText(LINK)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: "Luigi's" })).toBeInTheDocument()
})

test('a bill with no restaurant name still has a title', async () => {
  stubApi(() => jsonResponse(200, { ...BILL, restaurant_name: null }))
  renderSharePage()

  expect(await screen.findByRole('heading', { name: 'Your bill' })).toBeInTheDocument()
})

test('Copy link puts the link on the clipboard', async () => {
  const user = userEvent.setup()
  stubApi()
  renderSharePage()

  await user.click(await screen.findByRole('button', { name: 'Copy link' }))

  expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
  expect(await navigator.clipboard.readText()).toBe(LINK)
})

test('says so if the link could not be copied', async () => {
  const user = userEvent.setup()
  stubApi()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('blocked'))
  renderSharePage()

  await user.click(await screen.findByRole('button', { name: 'Copy link' }))

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't copy it.")
  expect(screen.getByText(LINK)).toBeInTheDocument()
})

test('shows what everyone owes, from the API', async () => {
  stubApi()
  renderSharePage()

  expect(await screen.findByText('Brandon (Captain)')).toBeInTheDocument()
  expect(screen.getByText('$31.36')).toBeInTheDocument()
  expect(screen.getByText('Ana')).toBeInTheDocument()
  expect(screen.getByText('$18.56')).toBeInTheDocument()
  expect(screen.getByText('$49.92')).toBeInTheDocument()
  expect(screen.queryByText('Nobody else has joined yet.')).not.toBeInTheDocument()
})

test('says when nobody else has joined', async () => {
  stubApi(undefined, () =>
    jsonResponse(200, { people: [person('cap', 'Brandon', 4992)], unclaimed_item_ids: [] }),
  )
  renderSharePage()

  expect(await screen.findByText('Nobody else has joined yet.')).toBeInTheDocument()
})

test('warns the Captain which unclaimed items count as theirs', async () => {
  stubApi(undefined, () => jsonResponse(200, { ...TOTALS, unclaimed_item_ids: ['nachos'] }))
  renderSharePage()

  const warning = await screen.findByRole('status')
  expect(warning).toHaveTextContent('No dibs yet, so these count as yours:')
  expect(warning).toHaveTextContent('Nachos ($9.00)')
  expect(warning).not.toHaveTextContent('Burger')
})

test('shows no warning when everything is claimed', async () => {
  stubApi()
  renderSharePage()

  await screen.findByText('Brandon (Captain)')

  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('never uses the word share in what the Captain reads', async () => {
  stubApi(() => jsonResponse(200, { ...BILL, restaurant_name: null }))
  renderSharePage()

  await screen.findByText('Brandon (Captain)')

  expect(document.body.textContent).not.toMatch(/share/i)
})

test('links to the page where the Captain claims their own items', async () => {
  const user = userEvent.setup()
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'cap', token: 'cap-token' }),
  )
  stubApi()
  renderSharePage()

  await user.click(await screen.findByRole('link', { name: 'Call dibs on your items' }))

  expect(await screen.findByText("You're in, Brandon.")).toBeInTheDocument()
})

test('a locked bill hides the QR code', async () => {
  stubApi(() => jsonResponse(200, { ...BILL, status: 'LOCKED' }))
  renderSharePage()

  expect(await screen.findByText('This bill is locked, so nobody new can join.')).toBeInTheDocument()
  expect(screen.queryByTitle('QR code to join this bill')).not.toBeInTheDocument()
  expect(await screen.findByText('Brandon (Captain)')).toBeInTheDocument()
})

test('Refresh picks up new people and amounts', async () => {
  const user = userEvent.setup()
  let totals = { people: [person('cap', 'Brandon', 4992)], unclaimed_item_ids: [] }
  stubApi(undefined, () => jsonResponse(200, totals))
  renderSharePage()
  await screen.findByText('Nobody else has joined yet.')

  totals = TOTALS as typeof totals
  await user.click(screen.getByRole('button', { name: 'Refresh' }))

  expect(await screen.findByText('$18.56')).toBeInTheDocument()
})

test('an unknown bill says so and offers a way back', async () => {
  stubApi(() => jsonResponse(404, { detail: 'bill not found' }))
  renderSharePage()

  expect(await screen.findByRole('heading', { name: 'Bill not found' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Create a bill' })).toHaveAttribute('href', '/')
  expect(screen.queryByTitle('QR code to join this bill')).not.toBeInTheDocument()
})

test('a failed bill load can be tried again', async () => {
  const user = userEvent.setup()
  let healthy = false
  stubApi(() => {
    if (!healthy) throw new TypeError('Failed to fetch')
    return jsonResponse(200, BILL)
  })
  renderSharePage()

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByText(LINK)).toBeInTheDocument()
})

test('if only the totals fail, the QR code still works and they can be retried', async () => {
  const user = userEvent.setup()
  let healthy = false
  stubApi(undefined, () =>
    healthy ? jsonResponse(200, TOTALS) : jsonResponse(500, { detail: 'totals are broken' }),
  )
  renderSharePage()

  expect(await screen.findByRole('alert')).toHaveTextContent('totals are broken')
  expect(screen.getByTitle('QR code to join this bill')).toBeInTheDocument()
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByText('$31.36')).toBeInTheDocument()
})
