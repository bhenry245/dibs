import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, type Mock, test, vi } from 'vitest'
import App from '../App.tsx'
import { shrinkImage, UnreadableImageError } from '../image.ts'

vi.mock('../image.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image.ts')>()),
  shrinkImage: vi.fn(),
}))

const SHRUNK = new Blob(['small'], { type: 'image/jpeg' })
const PHOTO = new File(['huge'], 'receipt.heic', { type: 'image/heic' })

const DRAFT = {
  bill: {
    share_code: 'abc123',
    status: 'DRAFT',
    restaurant_name: "Luigi's",
    subtotal_cents: 2000,
    tax_cents: 160,
    tip_cents: 0,
    fees_cents: 0,
    total_cents: 2160,
    split_tip: true,
    items: [{ id: 'i1', description: 'Burger', price_cents: 2000, position: 0, claims: [] }],
    crew: [{ id: 'cap', name: 'Brandon', is_captain: true }],
  },
  warnings: [],
  printed_total_cents: 2160,
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

const UPLOAD = {
  upload_id: 'upload-1',
  url: 'https://bucket.s3.test/',
  fields: { key: 'receipts/upload-1.jpg', 'Content-Type': 'image/jpeg', policy: 'signed' },
}

function stubApi(
  scan: () => unknown = () => jsonResponse(201, created()),
  {
    createUpload = (): unknown => jsonResponse(201, UPLOAD),
    s3 = (): unknown => ({ ok: true, status: 204 }),
  } = {},
): Mock {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/health') return jsonResponse(200, { status: 'ok' })
    if (url === '/api/bills/abc123/draft') return jsonResponse(200, DRAFT)
    if (url === '/api/receipts/upload-url') return createUpload()
    if (url === UPLOAD.url) return s3()
    return scan()
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function created() {
  return { draft: DRAFT, crew_member_id: 'cap', token: 'cap-token' }
}

function renderCreatePage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function scanCalls(fetchMock: Mock) {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/bills/from-receipt')
}

async function fillInAboutYou(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Your name'), ' Brandon ')
  await user.type(screen.getByLabelText('Your email'), 'brandon@example.com')
}

// The label changes while reading, so find the input directly.
function fileInput() {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!
}

beforeEach(() => {
  vi.mocked(shrinkImage).mockReset()
  vi.mocked(shrinkImage).mockResolvedValue(SHRUNK)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

test('uploads the shrunk photo to S3, then scans it, then opens the review screen', async () => {
  const user = userEvent.setup({ applyAccept: false })
  const fetchMock = stubApi()
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('heading', { name: 'Check your receipt' })).toBeInTheDocument()
  expect(shrinkImage).toHaveBeenCalledWith(PHOTO)

  const order = fetchMock.mock.calls
    .map(([url]) => url)
    .filter((url) => url !== '/api/health' && !url.endsWith('/draft'))
  expect(order).toEqual([
    '/api/receipts/upload-url',
    UPLOAD.url,
    '/api/bills/from-receipt',
  ])

  const [, s3Init] = fetchMock.mock.calls.find(([url]) => url === UPLOAD.url)!
  expect(s3Init.method).toBe('POST')
  expect(s3Init.headers).toBeUndefined()
  const form = s3Init.body as FormData
  expect([...form.keys()]).toEqual(['key', 'Content-Type', 'policy', 'file'])
  expect(form.get('key')).toBe('receipts/upload-1.jpg')
  const photo = form.get('file') as File
  expect(photo.name).toBe('receipt.jpg')
  expect(await photo.text()).toBe('small')

  const [, scanInit] = scanCalls(fetchMock)[0]
  expect(scanInit.method).toBe('POST')
  expect(JSON.parse(scanInit.body)).toEqual({
    upload_id: 'upload-1',
    captain_email: 'brandon@example.com',
    captain_name: 'Brandon',
    restaurant_name: null,
  })
})

test('sends a typed restaurant name with the scan', async () => {
  const user = userEvent.setup({ applyAccept: false })
  const fetchMock = stubApi()
  renderCreatePage()

  await fillInAboutYou(user)
  await user.type(screen.getByLabelText('Restaurant (optional)'), " Mom's Place ")
  await user.upload(fileInput(), PHOTO)

  await screen.findByRole('heading', { name: 'Check your receipt' })
  expect(JSON.parse(scanCalls(fetchMock)[0][1].body).restaurant_name).toBe("Mom's Place")
})

test('a failed upload is explained, and the photo is never scanned', async () => {
  const user = userEvent.setup({ applyAccept: false })
  const fetchMock = stubApi(undefined, { s3: () => ({ ok: false, status: 403 }) })
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('alert')).toHaveTextContent("Your photo couldn't be uploaded.")
  expect(scanCalls(fetchMock)).toHaveLength(0)
})

test('being unable to start an upload is explained, and nothing is uploaded', async () => {
  const user = userEvent.setup({ applyAccept: false })
  const fetchMock = stubApi(undefined, {
    createUpload: () => jsonResponse(429, { detail: 'Too many receipts today.' }),
  })
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('alert')).toHaveTextContent('Too many receipts today.')
  expect(fetchMock.mock.calls.some(([url]) => url === UPLOAD.url)).toBe(false)
})

test('keeps the token on the device for the review screen', async () => {
  const user = userEvent.setup({ applyAccept: false })
  stubApi()
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  await screen.findByRole('heading', { name: 'Check your receipt' })
  expect(JSON.parse(localStorage.getItem('dibs.identity.abc123')!)).toEqual({
    crewMemberId: 'cap',
    token: 'cap-token',
  })
})

test.each([
  ['name', 'Your email', 'brandon@example.com'],
  ['email', 'Your name', 'Brandon'],
])('scanning stays off without your %s', async (_missing, label, value) => {
  const user = userEvent.setup({ applyAccept: false })
  const fetchMock = stubApi()
  renderCreatePage()

  await user.type(screen.getByLabelText(label), value)
  expect(fileInput()).toBeDisabled()
  await user.upload(fileInput(), PHOTO)

  expect(screen.getByText('Add your name and email to scan or create a bill.')).toBeInTheDocument()
  expect(shrinkImage).not.toHaveBeenCalled()
  expect(scanCalls(fetchMock)).toHaveLength(0)
})

test('shows it is reading, and a second photo cannot start while it does', async () => {
  const user = userEvent.setup({ applyAccept: false })
  let finish: (response: unknown) => void = () => {}
  const fetchMock = stubApi(() => new Promise((resolve) => (finish = resolve)))
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('status')).toHaveTextContent('up to a minute')
  expect(screen.getByText('Reading your receipt…')).toBeInTheDocument()
  expect(fileInput()).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Create bill' })).toBeDisabled()
  await user.upload(fileInput(), PHOTO)
  expect(scanCalls(fetchMock)).toHaveLength(1)
  finish(jsonResponse(201, created()))
  await screen.findByRole('heading', { name: 'Check your receipt' })
})

test.each([
  [422, "This doesn't look like a receipt, or it's too hard to read."],
  [429, 'Too many receipts have been scanned today. Type this one in instead.'],
  [503, "Couldn't read the receipt right now."],
])('shows the API error for a %i and lets you type the bill in', async (status, detail) => {
  const user = userEvent.setup({ applyAccept: false })
  stubApi(() => jsonResponse(status, { detail }))
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('alert')).toHaveTextContent(detail)
  expect(screen.getByLabelText('Your name')).toHaveValue(' Brandon ')
  expect(screen.getByRole('button', { name: 'Create bill' })).toBeEnabled()
  expect(fileInput()).toBeEnabled()
})

test('says so when the API cannot be reached', async () => {
  const user = userEvent.setup({ applyAccept: false })
  stubApi(() => {
    throw new TypeError('Failed to fetch')
  })
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Dibs.")
})

test('a photo the browser cannot open is explained and never uploaded', async () => {
  const user = userEvent.setup({ applyAccept: false })
  vi.mocked(shrinkImage).mockRejectedValue(new UnreadableImageError('Try a JPEG or PNG.'))
  const fetchMock = stubApi()
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)

  expect(await screen.findByRole('alert')).toHaveTextContent('Try a JPEG or PNG.')
  expect(scanCalls(fetchMock)).toHaveLength(0)
})

test('the same photo can be tried again after a failure', async () => {
  const user = userEvent.setup({ applyAccept: false })
  let healthy = false
  const fetchMock = stubApi(() =>
    healthy ? jsonResponse(201, created()) : jsonResponse(503, { detail: 'busy' }),
  )
  renderCreatePage()

  await fillInAboutYou(user)
  await user.upload(fileInput(), PHOTO)
  await screen.findByRole('alert')
  expect(fileInput().value).toBe('')
  healthy = true
  await user.upload(fileInput(), PHOTO)

  await screen.findByRole('heading', { name: 'Check your receipt' })
  expect(scanCalls(fetchMock)).toHaveLength(2)
})
