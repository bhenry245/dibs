import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, type Mock, test, vi } from 'vitest'
import App from '../App.tsx'

type Draft = {
  bill: Record<string, unknown> & { total_cents: number }
  warnings: string[]
  printed_total_cents: number | null
}

function makeDraft(overrides: Partial<Draft> = {}, billOverrides = {}): Draft {
  return {
    bill: {
      share_code: 'abc123',
      status: 'DRAFT',
      restaurant_name: "Luigi's",
      subtotal_cents: 3000,
      tax_cents: 240,
      tip_cents: 600,
      fees_cents: 0,
      total_cents: 3840,
      split_tip: true,
      venmo_handle: '@brandon',
      items: [
        { id: 'i1', description: 'Burger', price_cents: 2000, position: 0, claims: [] },
        { id: 'i2', description: 'Salad', price_cents: 1000, position: 1, claims: [] },
      ],
      crew: [{ id: 'cap', name: 'Brandon', is_captain: true }],
      ...billOverrides,
    },
    warnings: [],
    printed_total_cents: 3840,
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

// Stands in for the API. A save recalculates the total the way the server does.
function stubApi({
  draft = makeDraft(),
  getDraft,
  put,
  open,
}: {
  draft?: Draft
  getDraft?: () => unknown
  put?: () => unknown
  open?: () => unknown
} = {}): Mock {
  let current = draft
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft') && init?.method === 'PUT') {
      if (put) return put()
      const details = JSON.parse(init.body as string)
      const subtotal = details.items.reduce(
        (sum: number, item: { price_cents: number }) => sum + item.price_cents,
        0,
      )
      current = {
        ...current,
        bill: {
          ...current.bill,
          ...details,
          subtotal_cents: subtotal,
          total_cents: subtotal + details.tax_cents + details.tip_cents + details.fees_cents,
        },
      }
      return jsonResponse(200, current)
    }
    if (url.endsWith('/draft')) return getDraft ? getDraft() : jsonResponse(200, current)
    if (url.endsWith('/open')) {
      if (open) return open()
      return jsonResponse(200, { ...current.bill, status: 'OPEN' })
    }
    if (url.endsWith('/totals')) return jsonResponse(200, { people: [], unclaimed_item_ids: [] })
    return jsonResponse(200, { ...current.bill, status: 'OPEN' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderReviewPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/bills/abc123/review']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function callsTo(fetchMock: Mock, method: string, ending: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && url.endsWith(ending),
  )
}

async function loaded() {
  await screen.findByRole('heading', { name: 'Check your receipt' })
}

beforeEach(() => {
  localStorage.setItem(
    'dibs.identity.abc123',
    JSON.stringify({ crewMemberId: 'cap', token: 'cap-token' }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('loads what the scan found into editable fields, using your token', async () => {
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  expect(screen.getByLabelText('Restaurant (optional)')).toHaveValue("Luigi's")
  expect(screen.getByLabelText('Item 1')).toHaveValue('Burger')
  expect(screen.getByLabelText('Price of item 1')).toHaveValue('20.00')
  expect(screen.getByLabelText('Item 2')).toHaveValue('Salad')
  expect(screen.getByLabelText('Tax')).toHaveValue('2.40')
  expect(screen.getByLabelText('Tip')).toHaveValue('6.00')
  expect(screen.getByLabelText('Also split the tip')).toBeChecked()
  expect(callsTo(fetchMock, 'GET', '/draft')[0][1].headers.Authorization).toBe('Bearer cap-token')
})

test('a bill with no restaurant name loads with a blank field', async () => {
  stubApi({ draft: makeDraft({}, { restaurant_name: null }) })
  renderReviewPage()
  await loaded()

  expect(screen.getByLabelText('Restaurant (optional)')).toHaveValue('')
})

test('shows every warning from the scan', async () => {
  stubApi({ draft: makeDraft({ warnings: ['First problem.', 'Second problem.'] }) })
  renderReviewPage()
  await loaded()

  const warnings = screen.getByRole('status')
  expect(warnings).toHaveTextContent('First problem.')
  expect(warnings).toHaveTextContent('Second problem.')
})

test('shows no warning box for a clean scan', async () => {
  stubApi()
  renderReviewPage()
  await loaded()

  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('says when the bill matches the printed total', async () => {
  stubApi()
  renderReviewPage()
  await loaded()

  expect(screen.getByText('The bill matches the receipt.')).toBeInTheDocument()
})

test('shows both totals when they differ', async () => {
  stubApi({ draft: makeDraft({ printed_total_cents: 5320 }) })
  renderReviewPage()
  await loaded()

  expect(screen.getByText('Bill total').nextSibling).toHaveTextContent('$38.40')
  expect(screen.getByText('Total printed on the receipt').nextSibling).toHaveTextContent('$53.20')
  expect(screen.getByText(/These don't match/)).toBeInTheDocument()
})

test('a receipt with no printed total has nothing to compare', async () => {
  stubApi({ draft: makeDraft({ printed_total_cents: null }) })
  renderReviewPage()
  await loaded()

  expect(screen.queryByText('Total printed on the receipt')).not.toBeInTheDocument()
  expect(screen.queryByText(/match/)).not.toBeInTheDocument()
})

test('editing asks you to save, and saving sends cents and updates the total', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  const price = screen.getByLabelText('Price of item 1')
  await user.clear(price)
  await user.type(price, '19.99')
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
  expect(screen.queryByText('The bill matches the receipt.')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  expect(await screen.findByText(/These don't match/)).toBeInTheDocument()
  expect(screen.getByText('Bill total').nextSibling).toHaveTextContent('$38.39')
  const [, init] = callsTo(fetchMock, 'PUT', '/draft')[0]
  expect(init.headers.Authorization).toBe('Bearer cap-token')
  expect(JSON.parse(init.body)).toEqual({
    restaurant_name: "Luigi's",
    tax_cents: 240,
    tip_cents: 600,
    fees_cents: 0,
    split_tip: true,
    venmo_handle: '@brandon',
    cashapp_tag: null,
    zelle_contact: null,
    paypal_handle: null,
    items: [
      { description: 'Burger', price_cents: 1999 },
      { description: 'Salad', price_cents: 1000 },
    ],
  })
})

test('anything typed while a save is running still counts as unsaved', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const fetchMock = stubApi({ put: () => new Promise((resolve) => (finish = resolve)) })
  renderReviewPage()
  await loaded()

  await user.type(screen.getByLabelText('Item 1'), ' Deluxe')
  await user.click(screen.getByRole('button', { name: 'Save and check total' }))
  await screen.findByRole('button', { name: 'Saving…' })
  await user.type(screen.getByLabelText('Item 2'), ' Large')
  expect(callsTo(fetchMock, 'PUT', '/draft')).toHaveLength(1)
  finish(jsonResponse(200, makeDraft()))

  await screen.findByRole('button', { name: 'Save and check total' })
  expect(screen.getByLabelText('Item 2')).toHaveValue('Salad Large')
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
})

test('undoing an edit no longer counts as unsaved', async () => {
  const user = userEvent.setup()
  stubApi()
  renderReviewPage()
  await loaded()

  const tax = screen.getByLabelText('Tax')
  await user.type(tax, '9')
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
  await user.type(tax, '{Backspace}')

  expect(screen.getByText('The bill matches the receipt.')).toBeInTheDocument()
})

test('setting tax to zero fixes a receipt whose tax was already in the prices', async () => {
  const user = userEvent.setup()
  stubApi({
    draft: makeDraft(
      { printed_total_cents: 5320, warnings: ['The subtotal, tax, tip and fees add up to $58.03.'] },
      {
        subtotal_cents: 5320,
        tax_cents: 483,
        tip_cents: 0,
        total_cents: 5803,
        items: [{ id: 'i1', description: 'Meal', price_cents: 5320, position: 0, claims: [] }],
      },
    ),
  })
  renderReviewPage()
  await loaded()

  await user.clear(screen.getByLabelText('Tax'))
  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  expect(await screen.findByText('The bill matches the receipt.')).toBeInTheDocument()
})

test('fees from the scan can be edited and count towards the total', async () => {
  const user = userEvent.setup()
  stubApi({ draft: makeDraft({ printed_total_cents: 4151 }, { fees_cents: 311, total_cents: 4151 }) })
  renderReviewPage()
  await loaded()

  expect(screen.getByLabelText('Fees')).toHaveValue('3.11')
  expect(screen.getByText('Subtotal').nextSibling).toHaveTextContent('$30.00')
  expect(screen.getByText('The bill matches the receipt.')).toBeInTheDocument()
  await user.clear(screen.getByLabelText('Fees'))
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  expect(await screen.findByText(/These don't match/)).toBeInTheDocument()
  expect(screen.getByText('Bill total').nextSibling).toHaveTextContent('$38.40')
})

test('with no payment info, Open bill asks first and opens nothing yet', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi({ draft: makeDraft({}, { venmo_handle: null }) })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Open bill' }))

  expect(screen.getByRole('dialog', { name: 'How will people pay you back?' })).toBeInTheDocument()
  expect(callsTo(fetchMock, 'PUT', '/draft')).toHaveLength(0)
  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(0)
})

test('adding payment info from the modal goes back to the form and jumps to Venmo', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi({ draft: makeDraft({}, { venmo_handle: null }) })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Open bill' }))
  await user.click(screen.getByRole('button', { name: 'Add payment info' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Venmo')).toHaveFocus()
  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(0)
})

test('choosing to collect another way opens the bill', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi({ draft: makeDraft({}, { venmo_handle: null }) })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Open bill' }))
  await user.click(screen.getByRole('button', { name: "I'll collect another way" }))

  await screen.findByRole('heading', { name: 'Have everyone scan this' })
  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(1)
})

test('Save and check total never asks about payment', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi({ draft: makeDraft({}, { venmo_handle: null }) })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  await vi.waitFor(() => expect(callsTo(fetchMock, 'PUT', '/draft')).toHaveLength(1))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('payment info can be added during review, and counts as unsaved', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi({ draft: makeDraft({}, { venmo_handle: null }) })
  renderReviewPage()
  await loaded()

  await user.type(screen.getByLabelText('Venmo'), '@brandon')
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Open bill' }))

  await screen.findByRole('heading', { name: 'Have everyone scan this' })
  expect(JSON.parse(callsTo(fetchMock, 'PUT', '/draft')[0][1].body).venmo_handle).toBe('@brandon')
})

test('payment info already on a draft loads into the form', async () => {
  stubApi({ draft: makeDraft({}, { cashapp_tag: '$brandon', paypal_handle: 'brandonpays' }) })
  renderReviewPage()
  await loaded()

  expect(screen.getByLabelText('Cash App')).toHaveValue('$brandon')
  expect(screen.getByLabelText('PayPal (your PayPal.Me name)')).toHaveValue('brandonpays')
})

test('items can be added and removed', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Remove item 1' }))
  await user.click(screen.getByRole('button', { name: 'Add item' }))
  await user.type(screen.getByLabelText('Item 2'), 'Soda')
  await user.type(screen.getByLabelText('Price of item 2'), '3')
  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  await screen.findByText('Bill total')
  await vi.waitFor(() => expect(callsTo(fetchMock, 'PUT', '/draft')).toHaveLength(1))
  expect(JSON.parse(callsTo(fetchMock, 'PUT', '/draft')[0][1].body).items).toEqual([
    { description: 'Salad', price_cents: 1000 },
    { description: 'Soda', price_cents: 300 },
  ])
})

test('unticking the box tells the API the Captain covers the tip', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  await user.click(screen.getByLabelText('Also split the tip'))
  await user.click(screen.getByRole('button', { name: 'Open bill' }))

  await screen.findByRole('heading', { name: 'Have everyone scan this' })
  expect(JSON.parse(callsTo(fetchMock, 'PUT', '/draft')[0][1].body).split_tip).toBe(false)
})

test('opening saves what is on screen first, then shows the QR code', async () => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  await user.type(screen.getByLabelText('Item 1'), ' Deluxe')
  await user.click(screen.getByRole('button', { name: 'Open bill' }))

  expect(await screen.findByRole('heading', { name: 'Have everyone scan this' })).toBeInTheDocument()
  const writes = fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT' || init?.method === 'POST')
    .map(([url, init]) => `${init.method} ${url}`)
  expect(writes).toEqual(['PUT /api/bills/abc123/draft', 'POST /api/bills/abc123/open'])
  expect(JSON.parse(callsTo(fetchMock, 'PUT', '/draft')[0][1].body).items[0].description).toBe(
    'Burger Deluxe',
  )
  expect(callsTo(fetchMock, 'POST', '/open')[0][1].headers.Authorization).toBe('Bearer cap-token')
})

test.each([
  ['Save and check total', 'Price of item 1', 'abc', 'Enter a valid price for Burger, like 12.50.'],
  ['Open bill', 'Tax', 'lots', 'Enter a valid tax amount, like 3.12.'],
])('%s does not send bad values', async (button, label, value, message) => {
  const user = userEvent.setup()
  const fetchMock = stubApi()
  renderReviewPage()
  await loaded()

  const input = screen.getByLabelText(label)
  await user.clear(input)
  await user.type(input, value)
  await user.click(screen.getByRole('button', { name: button }))

  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(callsTo(fetchMock, 'PUT', '/draft')).toHaveLength(0)
  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(0)
})

test('a failed save shows the error and keeps your edits', async () => {
  const user = userEvent.setup()
  stubApi({ put: () => jsonResponse(422, { detail: 'nope' }) })
  renderReviewPage()
  await loaded()

  await user.type(screen.getByLabelText('Item 1'), ' Deluxe')
  await user.click(screen.getByRole('button', { name: 'Save and check total' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('nope')
  expect(screen.getByLabelText('Item 1')).toHaveValue('Burger Deluxe')
  expect(screen.getByText('Save your changes to update the bill total.')).toBeInTheDocument()
})

test('a failed open stays on the review screen and can be tried again', async () => {
  const user = userEvent.setup()
  let healthy = false
  const fetchMock = stubApi({
    open: () =>
      healthy
        ? jsonResponse(200, { ...makeDraft().bill, status: 'OPEN' })
        : jsonResponse(500, { detail: 'broken' }),
  })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Open bill' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('broken')
  expect(screen.getByRole('button', { name: 'Open bill' })).toBeEnabled()

  healthy = true
  await user.click(screen.getByRole('button', { name: 'Open bill' }))

  expect(await screen.findByRole('heading', { name: 'Have everyone scan this' })).toBeInTheDocument()
  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(2)
})

test('a second tap while opening does not send anything twice', async () => {
  const user = userEvent.setup()
  let finish: (response: unknown) => void = () => {}
  const fetchMock = stubApi({ open: () => new Promise((resolve) => (finish = resolve)) })
  renderReviewPage()
  await loaded()

  await user.click(screen.getByRole('button', { name: 'Open bill' }))
  const opening = await screen.findByRole('button', { name: 'Opening…' })
  expect(opening).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save and check total' })).toBeDisabled()
  await user.click(opening)

  expect(callsTo(fetchMock, 'POST', '/open')).toHaveLength(1)
  finish(jsonResponse(200, { ...makeDraft().bill, status: 'OPEN' }))
  await screen.findByRole('heading', { name: 'Have everyone scan this' })
})

test('coming back after the bill is open goes to the QR code', async () => {
  stubApi({ getDraft: () => jsonResponse(409, { detail: 'bill is already open' }) })
  renderReviewPage()

  expect(await screen.findByRole('heading', { name: 'Have everyone scan this' })).toBeInTheDocument()
})

test('someone without the token cannot review, and nothing is requested', async () => {
  localStorage.clear()
  const fetchMock = stubApi()
  renderReviewPage()

  expect(await screen.findByRole('heading', { name: "Can't open this draft" })).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([401, 403, 404])('a %i gets the same message', async (status) => {
  stubApi({ getDraft: () => jsonResponse(status, { detail: 'no' }) })
  renderReviewPage()

  expect(await screen.findByRole('heading', { name: "Can't open this draft" })).toBeInTheDocument()
})

test('a failed load can be tried again', async () => {
  const user = userEvent.setup()
  let healthy = false
  stubApi({
    getDraft: () => {
      if (!healthy) throw new TypeError('Failed to fetch')
      return jsonResponse(200, makeDraft())
    },
  })
  renderReviewPage()

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
  healthy = true
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  await loaded()
})
