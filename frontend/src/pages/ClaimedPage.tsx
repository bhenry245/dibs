import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { type Bill, getBill, getTotals } from '../api.ts'
import { isClaimedBy, listNames, otherClaimers } from '../claims.ts'
import { loadIdentity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'
import Page from '../Page.tsx'
import TotalSummary from '../TotalSummary.tsx'
import { useLiveBill } from '../useLiveBill.ts'

function HowToPay({ bill, captainName }: { bill: Bill; captainName: string }) {
  const methods = [
    { label: 'Venmo', value: bill.venmo_handle },
    { label: 'Cash App', value: bill.cashapp_tag },
    { label: 'Zelle', value: bill.zelle_contact },
  ].filter((method) => method.value)

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold break-words text-gray-900">Pay {captainName}</h2>
      {methods.length > 0 ? (
        <dl className="flex flex-col gap-2">
          {methods.map((method) => (
            <div key={method.label} className="flex justify-between gap-4 text-gray-900">
              <dt>{method.label}</dt>
              <dd className="min-w-0 font-medium break-all">{method.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-gray-700">
          {captainName} hasn&apos;t added any payment info, so ask them how they&apos;d like to be
          paid.
        </p>
      )}
      {/* Until the lock step exists, amounts can still move (design §6). */}
      {bill.status === 'OPEN' && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your total may change if someone shares your items. Wait for {captainName} to confirm
          before paying.
        </p>
      )}
    </section>
  )
}

// What you see after calling dibs: what you claimed, what you owe, and how to pay.
function ClaimedPage() {
  const shareCode = useParams().shareCode!
  const [identity] = useState(() => loadIdentity(shareCode))
  const billPage = `/b/${encodeURIComponent(shareCode)}`
  const pollMs = useLiveBill(shareCode)

  const billQuery = useQuery({
    queryKey: ['bill', shareCode],
    queryFn: () => getBill(shareCode),
    refetchInterval: (latest) => (latest.state.data?.status === 'OPEN' ? pollMs : false),
    enabled: identity !== null,
  })
  const totalsQuery = useQuery({
    queryKey: ['totals', shareCode],
    queryFn: () => getTotals(shareCode),
    refetchInterval: pollMs,
    enabled: identity !== null,
  })

  if (!identity) return <Navigate to={billPage} replace />

  if (billQuery.isError && !billQuery.data) {
    return (
      <Page>
        <LoadError error={billQuery.error} onRetry={() => billQuery.refetch()} />
      </Page>
    )
  }

  if (!billQuery.data) {
    return (
      <Page>
        <p className="text-gray-600">Loading your items…</p>
      </Page>
    )
  }

  const bill = billQuery.data
  const myId = identity.crewMemberId
  const me = bill.crew.find((member) => member.id === myId)
  // Not on this bill, so the bill page can offer them the join form.
  if (!me) return <Navigate to={billPage} replace />

  const captainName = bill.crew.find((member) => member.is_captain)?.name ?? 'the Captain'
  const myItems = bill.items.filter((item) => isClaimedBy(item, myId))
  const myTotal = totalsQuery.data?.people.find((person) => person.crew_member_id === myId)

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          {myItems.length > 0 ? 'You called dibs!' : 'No dibs yet'}
        </h1>
        <p className="break-words text-gray-700">
          {myItems.length > 0
            ? `You claimed ${listNames(myItems.map((item) => item.description))}.`
            : "You haven't claimed anything on this bill."}
        </p>
      </header>

      {myItems.length > 0 && (
        <ul className="flex flex-col gap-2">
          {myItems.map((item) => {
            const others = otherClaimers(item, bill, myId)
            return (
              <li key={item.id} className="flex justify-between gap-4 text-gray-900">
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{item.description}</span>
                  {others.length > 0 && (
                    <span className="text-sm text-gray-600">Shared with {listNames(others)}</span>
                  )}
                </span>
                <span>{formatCents(item.price_cents)}</span>
              </li>
            )
          })}
        </ul>
      )}

      {totalsQuery.isError && !totalsQuery.data && (
        <LoadError error={totalsQuery.error} onRetry={() => totalsQuery.refetch()} />
      )}
      {totalsQuery.isPending && <p className="text-gray-600">Working out your total…</p>}
      {myTotal && (
        <section className="flex flex-col gap-3 rounded-lg bg-white p-4 shadow-sm">
          <TotalSummary person={myTotal} isCaptain={me.is_captain} />
        </section>
      )}

      {/* The Captain already paid the restaurant, so they have nobody to pay. */}
      {!me.is_captain && myItems.length > 0 && <HowToPay bill={bill} captainName={captainName} />}

      <div className="flex flex-col gap-3">
        {bill.status === 'OPEN' && (
          <Link
            to={billPage}
            className="rounded-lg border border-gray-900 bg-white px-4 py-3 text-center font-semibold text-gray-900 hover:bg-gray-100"
          >
            {myItems.length > 0 ? 'Change my items' : 'Pick my items'}
          </Link>
        )}
        {me.is_captain && (
          <Link
            to={`/bills/${encodeURIComponent(shareCode)}/share`}
            className="rounded-lg bg-gray-900 px-4 py-3 text-center font-semibold text-white hover:bg-gray-700"
          >
            Back to the QR code
          </Link>
        )}
      </div>
    </Page>
  )
}

export default ClaimedPage
