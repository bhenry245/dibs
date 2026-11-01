import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError, type Bill, describeError, getBill, joinBill } from '../api.ts'
import { type Identity, loadIdentity, saveIdentity } from '../identity.ts'
import { formatCents } from '../money.ts'
import { INPUT_CLASS } from '../styles.ts'

function BillSummary({ bill }: { bill: Bill }) {
  return (
    <section className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {bill.items.map((item) => (
          <li key={item.id} className="flex justify-between gap-4 text-gray-900">
            <span className="min-w-0 break-words">{item.description}</span>
            <span>{formatCents(item.price_cents)}</span>
          </li>
        ))}
      </ul>
      <dl className="flex flex-col gap-1 border-t border-gray-300 pt-3 text-sm text-gray-700">
        <div className="flex justify-between">
          <dt>Tax</dt>
          <dd>{formatCents(bill.tax_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tip</dt>
          <dd>{formatCents(bill.tip_cents)}</dd>
        </div>
        <div className="flex justify-between text-base font-semibold text-gray-900">
          <dt>Total</dt>
          <dd>{formatCents(bill.total_cents)}</dd>
        </div>
      </dl>
      <p className="text-sm text-gray-600">
        At the table: {bill.crew.map((member) => member.name).join(', ')}
      </p>
    </section>
  )
}

function JoinForm({
  shareCode,
  onJoined,
}: {
  shareCode: string
  onJoined: (identity: Identity) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      joinBill(shareCode, {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
      }),
    onSuccess: (joined) => {
      const identity = { crewMemberId: joined.crew_member_id, token: joined.token }
      saveIdentity(shareCode, identity)
      // Add them to the cached bill right away, so the page never shows the form to someone
      // who has just joined. The refetch then brings the rest of the bill up to date.
      queryClient.setQueryData<Bill>(
        ['bill', shareCode],
        (bill) =>
          bill && {
            ...bill,
            crew: [
              ...bill.crew,
              { id: joined.crew_member_id, name: name.trim(), is_captain: false },
            ],
          },
      )
      queryClient.invalidateQueries({ queryKey: ['bill', shareCode] })
      onJoined(identity)
    },
  })

  function handleSubmit(event: SyntheticEvent) {
    event.preventDefault()
    if (!phone.trim() && !email.trim()) {
      setFormError('Add a phone number or an email.')
      return
    }
    setFormError(null)
    mutation.mutate()
  }

  const errorMessage = formError ?? (mutation.error && describeError(mutation.error))

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-gray-900">Join this bill</h2>
      <label className="flex flex-col gap-1 text-sm text-gray-700">
        Your name
        <input
          className={INPUT_CLASS}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={100}
          required
        />
      </label>
      <p className="text-sm text-gray-600">
        Add a phone number or an email, so you can get a reminder to pay.
      </p>
      <label className="flex flex-col gap-1 text-sm text-gray-700">
        Phone
        <input
          className={INPUT_CLASS}
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          autoComplete="tel"
          maxLength={32}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-gray-700">
        Email
        <input
          className={INPUT_CLASS}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
        />
      </label>

      {errorMessage && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
        disabled={mutation.isPending}
      >
        {mutation.isPending ? 'Joining…' : 'Join'}
      </button>
    </form>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="mx-auto flex max-w-md flex-col gap-6">{children}</div>
    </main>
  )
}

// What the QR code opens: the bill, plus a way in for anyone who hasn't joined yet.
function BillPage() {
  const shareCode = useParams().shareCode!
  const [identity, setIdentity] = useState(() => loadIdentity(shareCode))

  const query = useQuery({
    queryKey: ['bill', shareCode],
    queryFn: () => getBill(shareCode),
  })

  if (query.isPending) {
    return (
      <Page>
        <p className="text-gray-600">Loading the bill…</p>
      </Page>
    )
  }

  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <Page>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Bill not found</h1>
          <p className="text-gray-600">
            This bill doesn&apos;t exist or isn&apos;t ready yet. Ask your Captain for the QR code.
          </p>
        </Page>
      )
    }
    return (
      <Page>
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(query.error)}
        </p>
        <button
          type="button"
          className="self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
          onClick={() => query.refetch()}
        >
          Try again
        </button>
      </Page>
    )
  }

  const bill = query.data
  // Check the saved identity against the bill, in case it's for someone no longer on it.
  const me = identity && bill.crew.find((member) => member.id === identity.crewMemberId)

  let nextStep = <JoinForm shareCode={shareCode} onJoined={setIdentity} />
  if (me) {
    nextStep = <p className="font-semibold text-gray-900">You&apos;re in, {me.name}.</p>
  } else if (bill.status !== 'OPEN') {
    nextStep = <p className="text-gray-700">This bill is locked, so nobody new can join.</p>
  }

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight break-words text-gray-900">
          {bill.restaurant_name ?? 'Your bill'}
        </h1>
      </header>
      <BillSummary bill={bill} />
      {nextStep}
    </Page>
  )
}

export default BillPage
