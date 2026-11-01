import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  ApiError,
  type Bill,
  type BillTotals,
  getBill,
  getTotals,
  POLL_INTERVAL_MS,
} from '../api.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'
import Page from '../Page.tsx'

const BUTTON_CLASS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100'

type CopyStatus = 'idle' | 'copied' | 'failed'

function ShareLink({ link }: { link: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  // The clipboard only works on https or localhost, and can be blocked. The link stays on screen
  // either way, so it can still be copied by hand.
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <section className="flex flex-col items-center gap-3 rounded-lg bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Have everyone scan this</h2>
      {/* Black on white, whatever the theme: scanners need the contrast. */}
      <QRCodeSVG value={link} size={224} marginSize={2} title="QR code to join this bill" />
      <p className="w-full text-center font-mono text-sm break-all text-gray-700">{link}</p>
      <button type="button" className={BUTTON_CLASS} onClick={copyLink}>
        {copyStatus === 'copied' ? 'Copied!' : 'Copy link'}
      </button>
      {copyStatus === 'failed' && (
        <p role="alert" className="text-sm text-gray-700">
          Couldn&apos;t copy it. Select the link above instead.
        </p>
      )}
    </section>
  )
}

function WhoOwesWhat({ bill, totals }: { bill: Bill; totals: BillTotals }) {
  const isCaptain = (id: string) => bill.crew.find((member) => member.id === id)?.is_captain
  const unclaimedItems = bill.items.filter((item) => totals.unclaimed_item_ids.includes(item.id))

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-gray-900">Who owes what</h2>
      {totals.people.length < 2 && (
        <p className="text-sm text-gray-600">Nobody else has joined yet.</p>
      )}
      <ul className="flex flex-col gap-2">
        {totals.people.map((person) => (
          <li key={person.crew_member_id} className="flex justify-between gap-4 text-gray-900">
            <span className="min-w-0 break-words">
              {person.name}
              {isCaptain(person.crew_member_id) && ' (Captain)'}
            </span>
            <span>{formatCents(person.total_cents)}</span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t border-gray-300 pt-3 font-semibold text-gray-900">
        <span>Bill total</span>
        <span>{formatCents(bill.total_cents)}</span>
      </p>
      {unclaimedItems.length > 0 && (
        <div role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">No dibs yet, so these count as yours:</p>
          <ul className="list-inside list-disc">
            {unclaimedItems.map((item) => (
              <li key={item.id} className="break-words">
                {item.description} ({formatCents(item.price_cents)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// The Captain's view after creating a bill: get people in, then see where things stand.
function ShareBillPage() {
  const shareCode = useParams().shareCode!
  const queryClient = useQueryClient()

  const billQuery = useQuery({
    queryKey: ['bill', shareCode],
    queryFn: () => getBill(shareCode),
    refetchInterval: POLL_INTERVAL_MS,
  })
  const totalsQuery = useQuery({
    queryKey: ['totals', shareCode],
    queryFn: () => getTotals(shareCode),
    refetchInterval: POLL_INTERVAL_MS,
  })

  if (billQuery.isPending) {
    return (
      <Page>
        <p className="text-gray-600">Loading the bill…</p>
      </Page>
    )
  }

  if (billQuery.isError && !billQuery.data) {
    if (billQuery.error instanceof ApiError && billQuery.error.status === 404) {
      return (
        <Page>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Bill not found</h1>
          <p className="text-gray-600">Check the link, or create a new bill.</p>
          <Link to="/" className="font-medium text-gray-900 underline">
            Create a bill
          </Link>
        </Page>
      )
    }
    return (
      <Page>
        <LoadError error={billQuery.error} onRetry={() => billQuery.refetch()} />
      </Page>
    )
  }

  const bill = billQuery.data!

  // Built from the address this page was opened on, so it points at whichever server is running.
  const link = `${window.location.origin}/b/${encodeURIComponent(shareCode)}`

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['bill', shareCode] })
    queryClient.invalidateQueries({ queryKey: ['totals', shareCode] })
  }

  return (
    <Page>
      <header>
        <p className="text-sm font-semibold text-gray-600">Dibs</p>
        <h1 className="text-3xl font-bold tracking-tight break-words text-gray-900">
          {bill.restaurant_name ?? 'Your bill'}
        </h1>
      </header>

      {bill.status === 'OPEN' ? (
        <ShareLink link={link} />
      ) : (
        <p className="text-gray-700">This bill is locked, so nobody new can join.</p>
      )}

      <Link
        to={`/b/${encodeURIComponent(shareCode)}`}
        className="rounded-lg bg-gray-900 px-4 py-3 text-center font-semibold text-white hover:bg-gray-700"
      >
        Call dibs on your items
      </Link>

      {totalsQuery.isPending && <p className="text-gray-600">Working out the totals…</p>}
      {totalsQuery.isError && !totalsQuery.data && (
        <LoadError error={totalsQuery.error} onRetry={() => totalsQuery.refetch()} />
      )}
      {totalsQuery.data && <WhoOwesWhat bill={bill} totals={totalsQuery.data} />}

      <button type="button" className={`${BUTTON_CLASS} self-start`} onClick={refresh}>
        Refresh
      </button>
    </Page>
  )
}

export default ShareBillPage
