import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, type Mock, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import App from './App.tsx'

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

const CREATED = {
  bill: { share_code: 'abc123' },
  crew_member_id: 'crew-1',
  token: 'secret-token',
}

// Answers the page's health check, and hands everything else to createResponse.
function stubFetch(createResponse: () => unknown = () => jsonResponse(201, CREATED)): Mock {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/health' ? jsonResponse(200, { status: 'ok' }) : createResponse(),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function sentBill(fetchMock: Mock) {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/bills')
  return call && JSON.parse(call[1].body)
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Your name'), 'Brandon')
  await user.type(screen.getByLabelText('Your email'), 'brandon@example.com')
  await user.type(screen.getByLabelText('Item 1'), 'Burger')
  await user.type(screen.getByLabelText('Price of item 1'), '20')
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('shows the API as connected when /api/health is ok', async () => {
  stubFetch()

  renderAt('/')

  expect(await screen.findByText('API connected')).toBeInTheDocument()
})

test('shows the API as unreachable when the request fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

  renderAt('/')

  expect(await screen.findByText('API unreachable')).toBeInTheDocument()
})

test('creates a bill with amounts in cents and opens the share page', async () => {
  const user = userEvent.setup()
  const fetchMock = stubFetch()
  renderAt('/')

  await fillRequiredFields(user)
  await user.type(screen.getByLabelText('Restaurant (optional)'), "Luigi's")
  await user.click(screen.getByRole('button', { name: 'Add item' }))
  await user.type(screen.getByLabelText('Item 2'), 'Salad')
  await user.type(screen.getByLabelText('Price of item 2'), '19.99')
  await user.type(screen.getByLabelText('Tax'), '3.12')
  await user.type(screen.getByLabelText('Tip'), '$7.80')
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  expect(await screen.findByText('abc123')).toBeInTheDocument()
  expect(sentBill(fetchMock)).toEqual({
    captain_email: 'brandon@example.com',
    captain_name: 'Brandon',
    restaurant_name: "Luigi's",
    tax_cents: 312,
    tip_cents: 780,
    split_tip: true,
    items: [
      { description: 'Burger', price_cents: 2000 },
      { description: 'Salad', price_cents: 1999 },
    ],
  })
})

test('keeps the token on the device, because the API only sends it once', async () => {
  const user = userEvent.setup()
  stubFetch()
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  await screen.findByText('abc123')
  expect(JSON.parse(localStorage.getItem('dibs.identity.abc123')!)).toEqual({
    crewMemberId: 'crew-1',
    token: 'secret-token',
  })
})

test('blank optional fields become null and zero, and blank rows are skipped', async () => {
  const user = userEvent.setup()
  const fetchMock = stubFetch()
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Add item' }))
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  await screen.findByText('abc123')
  expect(sentBill(fetchMock)).toMatchObject({
    restaurant_name: null,
    tax_cents: 0,
    tip_cents: 0,
    items: [{ description: 'Burger', price_cents: 2000 }],
  })
})

test('unticking the box tells the API the Captain covers the tip', async () => {
  const user = userEvent.setup()
  const fetchMock = stubFetch()
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByLabelText('Also split the tip'))
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  await screen.findByText('abc123')
  expect(sentBill(fetchMock).split_tip).toBe(false)
})

test('removing an item keeps the text in the other rows', async () => {
  const user = userEvent.setup()
  const fetchMock = stubFetch()
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Add item' }))
  await user.type(screen.getByLabelText('Item 2'), 'Salad')
  await user.type(screen.getByLabelText('Price of item 2'), '10')
  await user.click(screen.getByRole('button', { name: 'Remove item 1' }))

  expect(screen.getByLabelText('Item 1')).toHaveValue('Salad')
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  await screen.findByText('abc123')
  expect(sentBill(fetchMock).items).toEqual([{ description: 'Salad', price_cents: 1000 }])
})

test('the only item left cannot be removed', () => {
  stubFetch()

  renderAt('/')

  expect(screen.getByRole('button', { name: 'Remove item 1', hidden: true })).toBeDisabled()
})

test.each([
  ['no items', {}, 'Add at least one item.'],
  ['an item with no name', { price: '5' }, 'Every item needs a name.'],
  ['a bad price', { item: 'Soup', price: 'abc' }, 'Enter a valid price for Soup, like 12.50.'],
  ['a missing price', { item: 'Soup' }, 'Enter a valid price for Soup, like 12.50.'],
  [
    'a bad tax',
    { item: 'Soup', price: '5', tax: 'lots' },
    'Enter a valid tax amount, like 3.12.',
  ],
  ['a bad tip', { item: 'Soup', price: '5', tip: '-1' }, 'Enter a valid tip amount, like 7.80.'],
])('does not send a bill with %s', async (_name, fields, message) => {
  const { item, price, tax, tip } = fields as Record<string, string | undefined>
  const user = userEvent.setup()
  const fetchMock = stubFetch()
  renderAt('/')

  await user.type(screen.getByLabelText('Your name'), 'Brandon')
  await user.type(screen.getByLabelText('Your email'), 'brandon@example.com')
  if (item) await user.type(screen.getByLabelText('Item 1'), item)
  if (price) await user.type(screen.getByLabelText('Price of item 1'), price)
  if (tax) await user.type(screen.getByLabelText('Tax'), tax)
  if (tip) await user.type(screen.getByLabelText('Tip'), tip)
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(sentBill(fetchMock)).toBeUndefined()
})

test('shows why the API rejected the bill and keeps what was typed', async () => {
  const user = userEvent.setup()
  stubFetch(() =>
    jsonResponse(422, {
      detail: [{ msg: 'Value error, tax and tip need at least one item with a price' }],
    }),
  )
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    /^tax and tip need at least one item with a price$/,
  )
  expect(screen.getByLabelText('Item 1')).toHaveValue('Burger')
})

test('says so when the API cannot be reached', async () => {
  const user = userEvent.setup()
  stubFetch(() => {
    throw new TypeError('Failed to fetch')
  })
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Create bill' }))

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
})

test('a second tap while sending does not create a second bill', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const fetchMock = stubFetch(() => new Promise((resolve) => (finish = resolve)))
  renderAt('/')

  await fillRequiredFields(user)
  await user.click(screen.getByRole('button', { name: 'Create bill' }))
  const button = await screen.findByRole('button', { name: 'Creating…' })
  expect(button).toBeDisabled()
  await user.click(button)

  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/bills')).toHaveLength(1)
  finish(jsonResponse(201, CREATED))
  await screen.findByText('abc123')
})
