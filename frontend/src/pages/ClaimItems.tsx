import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  type Bill,
  describeError,
  getTotals,
  previewMyClaims,
  saveMyClaims,
} from '../api.ts'
import { isClaimedBy, listNames, otherClaimers } from '../claims.ts'
import type { Identity } from '../identity.ts'
import LoadError from '../LoadError.tsx'
import { formatCents } from '../money.ts'
import TotalSummary from '../TotalSummary.tsx'

type Item = Bill['items'][number]

function ClaimRow({
  item,
  bill,
  myId,
  isSelected,
  isOpen,
  onToggle,
}: {
  item: Item
  bill: Bill
  myId: string
  isSelected: boolean
  isOpen: boolean
  onToggle: () => void
}) {
  const others = otherClaimers(item, bill, myId)

  let claimers = ''
  if (isSelected) {
    claimers = ['You', ...others].join(' + ')
  } else if (others.length > 0) {
    claimers = `Claimed by ${listNames(others)}`
  }

  let colors = 'border-gray-300 bg-white'
  if (isSelected) {
    colors = 'border-green-600 bg-green-50'
  } else if (others.length > 0) {
    colors = 'border-gray-300 bg-gray-100'
  }

  return (
    <li>
      <button
        type="button"
        aria-pressed={isSelected}
        disabled={!isOpen}
        onClick={onToggle}
        className={`flex min-h-14 w-full items-center justify-between gap-4 rounded-lg border-2 px-3 py-2 text-left text-gray-900 ${colors}`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="break-words">{item.description}</span>
          {claimers && <span className="text-sm font-medium text-gray-700">{claimers}</span>}
          {!isSelected && others.length > 0 && isOpen && (
            <span className="text-sm text-gray-600">Tap to share it</span>
          )}
        </span>
        <span>{formatCents(item.price_cents)}</span>
      </button>
    </li>
  )
}

function YourTotal({
  bill,
  myId,
  isCaptain,
  pollMs,
}: {
  bill: Bill
  myId: string
  isCaptain: boolean
  pollMs: number
}) {
  const query = useQuery({
    queryKey: ['totals', bill.share_code],
    queryFn: () => getTotals(bill.share_code),
    refetchInterval: bill.status === 'OPEN' ? pollMs : false,
  })

  if (query.isPending) {
    return <p className="text-gray-600">Working out your total…</p>
  }

  if (query.isError && !query.data) {
    return <LoadError error={query.error} onRetry={() => query.refetch()} />
  }

  const totals = query.data!
  const mine = totals.people.find((person) => person.crew_member_id === myId)
  const unclaimedCount = totals.unclaimed_item_ids.length

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-white p-4 shadow-sm">
      {mine && <TotalSummary person={mine} isCaptain={isCaptain} />}
      {unclaimedCount > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {unclaimedCount === 1 ? '1 item has' : `${unclaimedCount} items have`} no dibs yet.
          {isCaptain && ' Anything left unclaimed counts as yours.'}
        </p>
      )}
    </section>
  )
}

function ConfirmDibs({
  bill,
  identity,
  isCaptain,
  selectedIds,
  onCancel,
}: {
  bill: Bill
  identity: Identity
  isCaptain: boolean
  selectedIds: string[]
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const dialog = useRef<HTMLDivElement>(null)
  const myId = identity.crewMemberId
  const shareCode = bill.share_code

  const chosenItems = bill.items.filter((item) => selectedIds.includes(item.id))
  const droppedItems = bill.items.filter(
    (item) => isClaimedBy(item, myId) && !selectedIds.includes(item.id),
  )

  const preview = useQuery({
    queryKey: ['preview', shareCode, selectedIds],
    queryFn: () => previewMyClaims(shareCode, identity.token, selectedIds),
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  const confirm = useMutation({
    mutationFn: () => saveMyClaims(shareCode, identity.token, selectedIds),
    onSuccess: async () => {
      // Waits for fresh data, so the next screen can't show the claims from before this save.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bill', shareCode] }),
        queryClient.invalidateQueries({ queryKey: ['totals', shareCode] }),
      ])
      navigate(`/b/${encodeURIComponent(shareCode)}/claimed`)
    },
    // The likeliest reason it failed is the bill changing, so show its real state behind this.
    onError: () => queryClient.invalidateQueries({ queryKey: ['bill', shareCode] }),
  })

  // Moves keyboard and screen reader focus into the modal when it opens.
  useEffect(() => {
    dialog.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dibs-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !confirm.isPending) onCancel()
        }}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-lg bg-white p-4 outline-none"
      >
        <h2 id="confirm-dibs-title" className="text-xl font-bold text-gray-900">
          Confirm your dibs
        </h2>

        {chosenItems.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {chosenItems.map((item) => {
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
        ) : (
          <p className="text-gray-700">You won&apos;t have any items.</p>
        )}

        {droppedItems.length > 0 && (
          <p className="text-sm text-gray-700">
            Dropping: {listNames(droppedItems.map((item) => item.description))}
          </p>
        )}

        <div className="flex flex-col gap-3 border-t border-gray-300 pt-3">
          {preview.isPending && <p className="text-gray-600">Working out your total…</p>}
          {preview.isError && (
            <LoadError error={preview.error} onRetry={() => preview.refetch()} />
          )}
          {preview.data && <TotalSummary person={preview.data} isCaptain={isCaptain} />}
        </div>

        {confirm.error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {describeError(confirm.error)}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            disabled={!preview.data || confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? 'Saving…' : 'Confirm'}
          </button>
          <button
            type="button"
            className="rounded-lg border border-gray-300 bg-white px-4 py-3 font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50"
            disabled={confirm.isPending}
            onClick={onCancel}
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  )
}

// The main screen once you're on a bill: pick what you had, then call dibs on all of it at once.
function ClaimItems({
  bill,
  identity,
  pollMs,
}: {
  bill: Bill
  identity: Identity
  pollMs: number
}) {
  const queryClient = useQueryClient()
  const myId = identity.crewMemberId
  const me = bill.crew.find((member) => member.id === myId)
  const isCaptain = me?.is_captain ?? false
  const isOpen = bill.status === 'OPEN'
  const savedIds = bill.items.filter((item) => isClaimedBy(item, myId)).map((item) => item.id)

  // Lives here rather than on the server until confirmed, so updates about other people's claims
  // never undo what someone is picking.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(savedIds))
  const [isConfirming, setIsConfirming] = useState(false)

  const hasChanges =
    selectedIds.size !== savedIds.length || savedIds.some((id) => !selectedIds.has(id))

  function toggle(itemId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (!next.delete(itemId)) next.add(itemId)
      return next
    })
  }

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
            ? "Tap what you had, then call dibs."
            : 'This bill is locked, so claims are final.'}
        </p>
        <p className="mt-2 text-sm font-medium text-gray-900">
          At the table: {bill.crew.map((member) => member.name).join(', ')}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {bill.items.map((item) => (
          <ClaimRow
            key={item.id}
            item={item}
            bill={bill}
            myId={myId}
            isSelected={selectedIds.has(item.id)}
            isOpen={isOpen}
            onToggle={() => toggle(item.id)}
          />
        ))}
      </ul>

      {isOpen && (
        <div className="sticky bottom-0 flex flex-col gap-2 bg-gray-50 py-2">
          <button
            type="button"
            className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            disabled={!hasChanges}
            onClick={() => setIsConfirming(true)}
          >
            Call dibs
          </button>
          {!hasChanges && savedIds.length > 0 && (
            <Link
              to={`/b/${encodeURIComponent(bill.share_code)}/claimed`}
              className="text-center text-sm font-medium text-gray-900 underline"
            >
              See what you claimed
            </Link>
          )}
        </div>
      )}

      {hasChanges && (
        <p className="text-sm text-gray-600">Your total updates after you call dibs.</p>
      )}
      <YourTotal bill={bill} myId={myId} isCaptain={isCaptain} pollMs={pollMs} />
      <button
        type="button"
        className="self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
        onClick={refresh}
      >
        Refresh
      </button>

      {isConfirming && (
        <ConfirmDibs
          bill={bill}
          identity={identity}
          isCaptain={isCaptain}
          selectedIds={[...selectedIds]}
          onCancel={() => setIsConfirming(false)}
        />
      )}
    </div>
  )
}

export default ClaimItems
