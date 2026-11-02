import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useState } from 'react'
import { useParams } from 'react-router'
import {
  ApiError,
  type Bill,
  describeError,
  getBill,
  joinBill,
} from '../api.ts'
import { type Identity, loadIdentity, saveIdentity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'
import Page from '../Page.tsx'
import { INPUT_CLASS, REQUIRED_LABEL_CLASS } from '../styles.ts'
import { useLiveBill } from '../useLiveBill.ts'
import { parseContact } from '../validation.ts'
import ClaimItems from './ClaimItems.tsx'

function ItemList({ bill }: { bill: Bill }) {
  return (
    <ul className="flex flex-col gap-2">
      {bill.items.map((item) => (
        <li key={item.id} className="flex justify-between gap-4 text-gray-900">
          <span className="min-w-0 break-words">{item.description}</span>
          <span>{formatCents(item.price_cents)}</span>
        </li>
      ))}
    </ul>
  )
}

function BillAmounts({ bill }: { bill: Bill }) {
  return (
    <section className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1 border-t border-gray-300 pt-3 text-sm text-gray-700">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd>{formatCents(bill.subtotal_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tax</dt>
          <dd>{formatCents(bill.tax_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tip</dt>
          <dd>{formatCents(bill.tip_cents)}</dd>
        </div>
        {bill.fees_cents > 0 && (
          <div className="flex justify-between">
            <dt>Fees</dt>
            <dd>{formatCents(bill.fees_cents)}</dd>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold text-gray-900">
          <dt>Total</dt>
          <dd>{formatCents(bill.total_cents)}</dd>
        </div>
      </dl>
    </section>
  )
}

// The first thing someone sees after scanning the QR code, with the bill behind it. It has no close
// button, because there's nothing to do here until you've joined.
function JoinModal({
  bill,
  onJoined,
}: {
  bill: Bill
  onJoined: (identity: Identity) => void
}) {
  const shareCode = bill.share_code
  // Every bill has a Captain, because creating one adds them to the crew.
  const captain = bill.crew.find((member) => member.is_captain)
  const title = `${bill.restaurant_name ?? `${captain?.name}'s`} bill`
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')

  // Greys out the button until the form can succeed. The API still checks everything itself.
  const parsedContact = parseContact(contact)
  const canJoin = Boolean(name.trim() && parsedContact)

  const mutation = useMutation({
    mutationFn: () =>
      joinBill(shareCode, {
        name: name.trim(),
        ...parsedContact!,
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
    mutation.mutate()
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-title"
        onSubmit={handleSubmit}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-lg bg-white p-4"
      >
        <h2 id="join-title" className="text-xl font-bold break-words text-gray-900">
          {title}
        </h2>
        <p className="text-sm text-gray-600">Join to call dibs on what you had.</p>
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          <span className={REQUIRED_LABEL_CLASS}>Your name</span>
          <input
            className={INPUT_CLASS}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            maxLength={100}
            autoFocus
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          <span className={REQUIRED_LABEL_CLASS}>Phone or email</span>
          <input
            className={INPUT_CLASS}
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            autoComplete="email"
            maxLength={320}
            aria-describedby="contact-hint"
            required
          />
        </label>
        <p id="contact-hint" className="-mt-2 text-sm text-gray-600">
          Only used for this bill. Never shown to anyone at the table.
        </p>

        {mutation.error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {describeError(mutation.error)}
          </p>
        )}

        <button
          type="submit"
          className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          disabled={!canJoin || mutation.isPending}
        >
          {mutation.isPending ? 'Joining…' : 'Join!'}
        </button>
      </form>
    </div>
  )
}

// What the QR code opens: the bill, plus a way in for anyone who hasn't joined yet.
function BillPage() {
  const shareCode = useParams().shareCode!
  const [identity, setIdentity] = useState(() => loadIdentity(shareCode))
  const pollMs = useLiveBill(shareCode)

  const query = useQuery({
    queryKey: ['bill', shareCode],
    queryFn: () => getBill(shareCode),
    // Keeps who has claimed what current. Once a bill is locked, nothing changes.
    refetchInterval: (latest) => (latest.state.data?.status === 'OPEN' ? pollMs : false),
  })

  if (query.isPending) {
    return (
      <Page>
        <p className="text-gray-600">Loading the bill…</p>
      </Page>
    )
  }

  // Only with nothing to show: a failed background check shouldn't lose someone's selections.
  if (query.isError && !query.data) {
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
        <LoadError error={query.error} onRetry={() => query.refetch()} />
      </Page>
    )
  }

  const bill = query.data!
  // Check the saved identity against the bill, in case it's for someone no longer on it.
  const me = identity && bill.crew.find((member) => member.id === identity.crewMemberId)

  if (me && identity) {
    return (
      <Page>
        <header>
          <p className="text-sm font-semibold text-gray-600">Dibs</p>
          <h1 className="text-3xl font-bold tracking-tight break-words text-gray-900">
            {bill.restaurant_name ?? 'Your bill'}
          </h1>
        </header>
        <ClaimItems bill={bill} identity={identity} pollMs={pollMs} />
        <BillAmounts bill={bill} />
      </Page>
    )
  }

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight break-words text-gray-900">
          {bill.restaurant_name ?? 'Your bill'}
        </h1>
      </header>
      <p className="text-sm font-medium text-gray-900">
        At the table: {bill.crew.map((member) => member.name).join(', ')}
      </p>
      <ItemList bill={bill} />
      <BillAmounts bill={bill} />
      {bill.status === 'OPEN' ? (
        <JoinModal bill={bill} onJoined={setIdentity} />
      ) : (
        <p className="text-gray-700">This bill is locked, so nobody new can join.</p>
      )}
    </Page>
  )
}

export default BillPage
