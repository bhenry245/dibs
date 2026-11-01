import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type Bill, claimItem, describeError, getTotals, unclaimItem } from '../api.ts'
import type { Identity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'

type Item = Bill['items'][number]

// Who's on an item, as people say it: "You + Anna". Uneven splits aren't offered in the UI yet.
function describeClaimers(item: Item, bill: Bill, myId: string): string {
  const others = item.claims
    .filter((claim) => claim.crew_member_id !== myId)
    .map((claim) => bill.crew.find((member) => member.id === claim.crew_member_id)?.name ?? '?')
  const isMine = item.claims.some((claim) => claim.crew_member_id === myId)
  return (isMine ? ['You', ...others] : others).join(' + ')
}

function ClaimRow({
  item,
  bill,
  identity,
  isOpen,
}: {
  item: Item
  bill: Bill
  identity: Identity
  isOpen: boolean
}) {
  const queryClient = useQueryClient()
  const isMine = item.claims.some((claim) => claim.crew_member_id === identity.crewMemberId)

  const mutation = useMutation({
    mutationFn: () =>
      isMine ? unclaimItem(item.id, identity.token) : claimItem(item.id, identity.token),
    // Also after a failure: the likeliest reason is the bill changing, so show its real state.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bill', bill.share_code] }),
        queryClient.invalidateQueries({ queryKey: ['totals', bill.share_code] }),
      ]),
  })

  const claimers = describeClaimers(item, bill, identity.crewMemberId)

  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-pressed={isMine}
        aria-busy={mutation.isPending}
        disabled={!isOpen || mutation.isPending}
        onClick={() => mutation.mutate()}
        className={`flex min-h-14 w-full items-center justify-between gap-4 rounded-lg border-2 px-3 py-2 text-left text-gray-900 ${
          isMine ? 'border-green-600 bg-green-50' : 'border-gray-300 bg-white'
        } ${mutation.isPending ? 'opacity-50' : ''}`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="break-words">{item.description}</span>
          {claimers && <span className="text-sm text-gray-600">{claimers}</span>}
        </span>
        <span>{formatCents(item.price_cents)}</span>
      </button>
      {mutation.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(mutation.error)}
        </p>
      )}
    </li>
  )
}

function YourTotal({ bill, myId, isCaptain }: { bill: Bill; myId: string; isCaptain: boolean }) {
  // Every amount comes from the API, so the cent-exact math only lives in split_bill.
  const query = useQuery({
    queryKey: ['totals', bill.share_code],
    queryFn: () => getTotals(bill.share_code),
  })

  if (query.isPending) {
    return <p className="text-gray-600">Working out your total…</p>
  }

  if (query.isError) {
    return <LoadError error={query.error} onRetry={() => query.refetch()} />
  }

  const mine = query.data.people.find((person) => person.crew_member_id === myId)
  const unclaimedCount = query.data.unclaimed_item_ids.length

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-white p-4 shadow-sm">
      {mine && (
        <>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {isCaptain ? 'Your total' : 'You owe'}
            </h2>
            <p className="text-2xl font-bold text-gray-900">{formatCents(mine.total_cents)}</p>
          </div>
          <dl className="flex flex-col gap-1 text-sm text-gray-700">
            <div className="flex justify-between">
              <dt>Your items</dt>
              <dd>{formatCents(mine.subtotal_cents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Your tax</dt>
              <dd>{formatCents(mine.tax_cents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Your tip</dt>
              <dd>{formatCents(mine.tip_cents)}</dd>
            </div>
          </dl>
        </>
      )}
      {unclaimedCount > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {unclaimedCount === 1 ? '1 item has' : `${unclaimedCount} items have`} no dibs yet.
          {isCaptain && ' Anything left unclaimed counts as yours.'}
        </p>
      )}
    </section>
  )
}

// The main screen once you're on a bill: tap what you had, and see what you owe.
function ClaimItems({ bill, identity }: { bill: Bill; identity: Identity }) {
  const queryClient = useQueryClient()
  const me = bill.crew.find((member) => member.id === identity.crewMemberId)
  const isOpen = bill.status === 'OPEN'

  // Other people's taps only arrive on a refetch until live updates come in Milestone 4.
  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['bill', bill.share_code] })
    queryClient.invalidateQueries({ queryKey: ['totals', bill.share_code] })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="font-semibold text-gray-900">You&apos;re in, {me?.name}.</p>
        <p className="text-sm text-gray-600">
          {isOpen
            ? 'Tap what you had. Tap it again to drop it.'
            : 'This bill is locked, so claims are final.'}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {bill.items.map((item) => (
          <ClaimRow key={item.id} item={item} bill={bill} identity={identity} isOpen={isOpen} />
        ))}
      </ul>
      <YourTotal bill={bill} myId={identity.crewMemberId} isCaptain={me?.is_captain ?? false} />
      <button
        type="button"
        className="self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
        onClick={refresh}
      >
        Refresh
      </button>
    </div>
  )
}

export default ClaimItems
