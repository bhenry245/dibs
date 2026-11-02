import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { describeError, getBill, lockBill, previewLock } from '../api.ts'
import { loadIdentity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'
import Page from '../Page.tsx'
import { INPUT_CLASS } from '../styles.ts'
import { useLiveBill } from '../useLiveBill.ts'

// Where the Captain makes the amounts final. Anything unclaimed is theirs unless they give it to
// someone, so that's the first thing on the page, and they have to confirm it (design §8).
function LockBillPage() {
  const shareCode = useParams().shareCode!
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [identity] = useState(() => loadIdentity(shareCode))
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [isConfirmed, setIsConfirmed] = useState(false)
  const pollMs = useLiveBill(shareCode)
  const sharePage = `/bills/${encodeURIComponent(shareCode)}/share`

  const billQuery = useQuery({
    queryKey: ['bill', shareCode],
    queryFn: () => getBill(shareCode),
    refetchInterval: pollMs,
  })
  const bill = billQuery.data
  const captain = bill?.crew.find((member) => member.is_captain)
  const isCaptain = Boolean(captain && captain.id === identity?.crewMemberId)
  const unclaimedItems = bill?.items.filter((item) => item.claims.length === 0) ?? []

  // Only what's still unclaimed, because someone can call dibs while the Captain is on this page.
  const assignments = Object.fromEntries(
    unclaimedItems
      .filter((item) => chosen[item.id] && chosen[item.id] !== captain?.id)
      .map((item) => [item.id, chosen[item.id]]),
  )

  const preview = useQuery({
    queryKey: ['lock-preview', shareCode, assignments],
    queryFn: () => previewLock(shareCode, identity!.token, assignments),
    enabled: isCaptain && bill?.status === 'OPEN',
    placeholderData: keepPreviousData,
  })

  const lock = useMutation({
    mutationFn: () => lockBill(shareCode, identity!.token, assignments),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bill', shareCode] }),
        queryClient.invalidateQueries({ queryKey: ['totals', shareCode] }),
        queryClient.invalidateQueries({ queryKey: ['settlements', shareCode] }),
      ])
      navigate(sharePage)
    },
    // The likeliest reason is someone just claiming an item, so show the bill as it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: ['bill', shareCode] }),
  })

  if (billQuery.isError && !bill) {
    return (
      <Page>
        <LoadError error={billQuery.error} onRetry={() => billQuery.refetch()} />
      </Page>
    )
  }

  if (!bill) {
    return (
      <Page>
        <p className="text-gray-600">Loading the bill…</p>
      </Page>
    )
  }

  if (!isCaptain) {
    return (
      <Page>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          Only the Captain can lock this bill
        </h1>
        <Link to={`/b/${encodeURIComponent(shareCode)}`} className="font-medium underline">
          Back to the bill
        </Link>
      </Page>
    )
  }

  if (bill.status !== 'OPEN') return <Navigate to={sharePage} replace />

  const hasUnclaimed = unclaimedItems.length > 0

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Lock this bill</h1>
        <p className="text-gray-600">
          Amounts become final, and nobody can join or change their items.
        </p>
      </header>

      {hasUnclaimed ? (
        <section className="flex flex-col gap-3 rounded-lg bg-amber-50 p-4">
          <h2 className="text-lg font-semibold text-amber-900">
            {unclaimedItems.length === 1
              ? '1 item has no dibs'
              : `${unclaimedItems.length} items have no dibs`}
          </h2>
          <p className="text-sm text-amber-900">
            These are yours unless you give them to someone.
          </p>
          {unclaimedItems.map((item) => (
            <label key={item.id} className="flex flex-col gap-1 text-sm text-amber-900">
              {item.description} ({formatCents(item.price_cents)})
              <select
                className={INPUT_CLASS}
                value={chosen[item.id] ?? captain?.id}
                onChange={(event) =>
                  setChosen((current) => ({ ...current, [item.id]: event.target.value }))
                }
              >
                {bill.crew.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.is_captain ? `${member.name} (you)` : member.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
      ) : (
        <p className="text-gray-700">Every item has been claimed.</p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-gray-900">Final amounts</h2>
        {preview.isPending && <p className="text-gray-600">Working out the amounts…</p>}
        {preview.isError && !preview.data && (
          <LoadError error={preview.error} onRetry={() => preview.refetch()} />
        )}
        {preview.data && (
          <ul
            className={`flex flex-col gap-2 ${preview.isPlaceholderData ? 'opacity-50' : ''}`}
          >
            {preview.data.people.map((person) => (
              <li key={person.crew_member_id} className="flex justify-between gap-4 text-gray-900">
                <span className="min-w-0 break-words">
                  {person.crew_member_id === captain?.id ? `${person.name} (you)` : person.name}
                </span>
                <span>{formatCents(person.total_cents)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="flex justify-between border-t border-gray-300 pt-3 font-semibold text-gray-900">
          <span>Bill total</span>
          <span>{formatCents(bill.total_cents)}</span>
        </p>
      </section>

      {hasUnclaimed && (
        <label className="flex items-start gap-2 text-sm text-gray-900">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={isConfirmed}
            onChange={(event) => setIsConfirmed(event.target.checked)}
          />
          I&apos;ve checked who gets the unclaimed items.
        </label>
      )}

      {lock.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(lock.error)}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          disabled={(hasUnclaimed && !isConfirmed) || !preview.data || lock.isPending}
          onClick={() => lock.mutate()}
        >
          {lock.isPending ? 'Locking…' : 'Lock bill'}
        </button>
        <Link
          to={`/b/${encodeURIComponent(shareCode)}`}
          className="text-center text-sm font-medium text-gray-900 underline"
        >
          Not yet
        </Link>
      </div>
    </Page>
  )
}

export default LockBillPage
