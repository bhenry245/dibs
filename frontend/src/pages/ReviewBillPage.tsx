import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ApiError, type BillDetails, describeError, type Draft, getDraft, openBill, updateDraft } from '../api.ts'
import BillFields from '../BillFields.tsx'
import { type BillFormValues, buildDetails, newRow } from '../billForm.ts'
import { loadIdentity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { centsToInput, formatCents } from '../money.ts'
import Page from '../Page.tsx'
import { INPUT_CLASS } from '../styles.ts'

// A fingerprint of what's typed, to tell whether anything has changed since the last save.
function snapshot(restaurantName: string, values: BillFormValues): string {
  return JSON.stringify([
    restaurantName,
    values.rows.map((row) => [row.description, row.price]),
    values.tax,
    values.tip,
    values.fees,
    values.splitTip,
  ])
}

function TotalCheck({ draft, hasUnsavedChanges }: { draft: Draft; hasUnsavedChanges: boolean }) {
  const printed = draft.printed_total_cents
  const total = draft.bill.total_cents

  return (
    <section className="flex flex-col gap-2 rounded-lg bg-white p-4 shadow-sm">
      <p className="flex justify-between font-semibold text-gray-900">
        <span>Bill total</span>
        <span>{formatCents(total)}</span>
      </p>
      {printed !== null && (
        <p className="flex justify-between text-sm text-gray-700">
          <span>Total printed on the receipt</span>
          <span>{formatCents(printed)}</span>
        </p>
      )}
      {hasUnsavedChanges ? (
        <p className="text-sm text-gray-600">Save your changes to update the bill total.</p>
      ) : (
        printed !== null &&
        (printed === total ? (
          <p className="text-sm text-green-800">The bill matches the receipt.</p>
        ) : (
          <p className="text-sm text-amber-900">
            These don&apos;t match. A tip you added yourself won&apos;t be on the printed total.
          </p>
        ))
      )}
    </section>
  )
}

function ReviewForm({
  shareCode,
  token,
  initialDraft,
}: {
  shareCode: string
  token: string
  initialDraft: Draft
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(initialDraft)
  const [restaurantName, setRestaurantName] = useState(initialDraft.bill.restaurant_name ?? '')
  const [values, setValues] = useState<BillFormValues>(() => ({
    rows: initialDraft.bill.items.map((item) =>
      newRow(item.description, centsToInput(item.price_cents)),
    ),
    tax: centsToInput(initialDraft.bill.tax_cents),
    tip: centsToInput(initialDraft.bill.tip_cents),
    fees: centsToInput(initialDraft.bill.fees_cents),
    splitTip: initialDraft.bill.split_tip,
  }))
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(restaurantName, values))
  const [formError, setFormError] = useState<string | null>(null)

  const currentSnapshot = snapshot(restaurantName, values)

  // The snapshot travels with the request, because typing can continue while it's being saved, and
  // anything typed since then still counts as unsaved.
  const save = useMutation({
    mutationFn: ({ details }: { details: BillDetails; sentSnapshot: string }) =>
      updateDraft(shareCode, token, details),
    onSuccess: (saved, { sentSnapshot }) => {
      setDraft(saved)
      setSavedSnapshot(sentSnapshot)
    },
  })

  // Always saves first, so the crew get exactly what's on screen.
  const open = useMutation({
    mutationFn: async (details: BillDetails) => {
      await updateDraft(shareCode, token, details)
      return openBill(shareCode, token)
    },
    onSuccess: (bill) => {
      queryClient.setQueryData(['bill', shareCode], bill)
      navigate(`/bills/${shareCode}/share`)
    },
  })

  const isBusy = save.isPending || open.isPending

  function detailsOrError(): BillDetails | null {
    const details = buildDetails(values, restaurantName)
    if (typeof details === 'string') {
      setFormError(details)
      return null
    }
    setFormError(null)
    return details
  }

  function handleSave() {
    const details = detailsOrError()
    if (details) save.mutate({ details, sentSnapshot: currentSnapshot })
  }

  function handleOpen(event: SyntheticEvent) {
    event.preventDefault()
    const details = detailsOrError()
    if (details) open.mutate(details)
  }

  const requestError = open.error ?? save.error
  const errorMessage = formError ?? (requestError && describeError(requestError))

  return (
    <form onSubmit={handleOpen} className="flex flex-col gap-6">
      {draft.warnings.length > 0 && (
        <section role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">Check these against your receipt:</p>
          <ul className="list-inside list-disc">
            {draft.warnings.map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </section>
      )}

      <label className="flex flex-col gap-1 text-sm text-gray-700">
        Restaurant (optional)
        <input
          className={INPUT_CLASS}
          value={restaurantName}
          onChange={(event) => setRestaurantName(event.target.value)}
          maxLength={200}
        />
      </label>

      <BillFields
        values={values}
        onChange={(change) => setValues((current) => ({ ...current, ...change }))}
      />

      <TotalCheck draft={draft} hasUnsavedChanges={currentSnapshot !== savedSnapshot} />

      {errorMessage && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="rounded-lg border border-gray-900 bg-white px-4 py-3 font-semibold text-gray-900 hover:bg-gray-100 disabled:opacity-50"
          onClick={handleSave}
          disabled={isBusy}
        >
          {save.isPending ? 'Saving…' : 'Save and check total'}
        </button>
        <button
          type="submit"
          className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          disabled={isBusy}
        >
          {open.isPending ? 'Opening…' : 'Open bill'}
        </button>
        <p className="text-center text-sm text-gray-600">
          Opening shows the QR code so everyone can call dibs.
        </p>
      </div>
    </form>
  )
}

function NotYourDraft() {
  return (
    <Page>
      <h1 className="text-3xl font-bold tracking-tight text-gray-900">Can&apos;t open this draft</h1>
      <p className="text-gray-600">Only the person who scanned this receipt can review it, on the same device.</p>
      <Link to="/" className="font-medium text-gray-900 underline">
        Create a bill
      </Link>
    </Page>
  )
}

// The Captain's chance to fix the AI's reading before anyone else sees the bill.
function ReviewBillPage() {
  const shareCode = useParams().shareCode!
  const [identity] = useState(() => loadIdentity(shareCode))

  const query = useQuery({
    queryKey: ['draft', shareCode],
    queryFn: () => getDraft(shareCode, identity!.token),
    enabled: identity !== null,
    // The form holds the Captain's edits. A background reload that failed would replace the form
    // with an error, so this only loads when the page opens.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  })

  if (!identity) return <NotYourDraft />

  if (query.isPending) {
    return (
      <Page>
        <p className="text-gray-600">Loading your receipt…</p>
      </Page>
    )
  }

  if (query.isError) {
    const status = query.error instanceof ApiError ? query.error.status : null
    // Already open, such as after pressing Back from the QR screen.
    if (status === 409) return <Navigate to={`/bills/${shareCode}/share`} replace />
    if (status === 401 || status === 403 || status === 404) return <NotYourDraft />
    return (
      <Page>
        <LoadError error={query.error} onRetry={() => query.refetch()} />
      </Page>
    )
  }

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Check your receipt</h1>
        <p className="text-gray-600">Fix anything that&apos;s wrong. Nobody else can see this yet.</p>
      </header>
      <ReviewForm shareCode={shareCode} token={identity.token} initialDraft={query.data} />
    </Page>
  )
}

export default ReviewBillPage
