import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  type Bill,
  confirmPayment,
  describeError,
  getSettlements,
  paymentNotReceived,
  reopenBill,
  type Settlement,
} from './api.ts'
import LoadError from './LoadError.tsx'
import { formatCents } from './money.ts'

const STATUS_LABEL: Record<string, string> = {
  OWED: 'Owes you',
  MARKED_PAID: 'Says they paid',
  CONFIRMED: 'Paid',
}

const BUTTON_CLASS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50'

function refreshBill(queryClient: ReturnType<typeof useQueryClient>, shareCode: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['bill', shareCode] }),
    queryClient.invalidateQueries({ queryKey: ['totals', shareCode] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', shareCode] }),
  ])
}

function SettlementRow({
  settlement,
  shareCode,
  captainToken,
}: {
  settlement: Settlement
  shareCode: string
  captainToken: string | null
}) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: (action: typeof confirmPayment) =>
      action(shareCode, captainToken!, settlement.id),
    onSettled: () => refreshBill(queryClient, shareCode),
  })
  const canAct = captainToken !== null && settlement.status !== 'CONFIRMED'

  return (
    <li className="flex flex-col gap-2 rounded-lg bg-white p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-4 text-gray-900">
        <span className="min-w-0 font-medium break-words">{settlement.name}</span>
        <span>{formatCents(settlement.total_cents)}</span>
      </div>
      <p className="text-sm text-gray-600">{STATUS_LABEL[settlement.status]}</p>
      {canAct && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={update.isPending}
            onClick={() => update.mutate(confirmPayment)}
          >
            Got it
          </button>
          {settlement.status === 'MARKED_PAID' && (
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={update.isPending}
              onClick={() => update.mutate(paymentNotReceived)}
            >
              Not received
            </button>
          )}
        </div>
      )}
      {update.error && (
        <p role="alert" className="text-sm text-red-800">
          {describeError(update.error)}
        </p>
      )}
    </li>
  )
}

// Who has paid on a locked bill. The Captain confirms money they've received, or reopens the bill
// if nobody has paid yet.
function SettleUp({
  bill,
  captainToken,
  pollMs,
}: {
  bill: Bill
  captainToken: string | null
  pollMs: number
}) {
  const shareCode = bill.share_code
  const queryClient = useQueryClient()
  const [isConfirmingReopen, setIsConfirmingReopen] = useState(false)

  const query = useQuery({
    queryKey: ['settlements', shareCode],
    queryFn: () => getSettlements(shareCode),
    refetchInterval: bill.status === 'LOCKED' ? pollMs : false,
  })

  const reopen = useMutation({
    mutationFn: () => reopenBill(shareCode, captainToken!),
    onSettled: () => refreshBill(queryClient, shareCode),
  })

  if (query.isPending) return <p className="text-gray-600">Loading who&apos;s paid…</p>
  if (query.isError && !query.data) {
    return <LoadError error={query.error} onRetry={() => query.refetch()} />
  }

  const settlements = query.data!
  const canReopen =
    captainToken !== null &&
    bill.status === 'LOCKED' &&
    settlements.every((settlement) => settlement.status === 'OWED')

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-gray-900">Who&apos;s paid</h2>
      {bill.status === 'SETTLED' && (
        <p className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
          Everyone&apos;s paid. This bill is settled.
        </p>
      )}
      {settlements.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {settlements.map((settlement) => (
            <SettlementRow
              key={settlement.id}
              settlement={settlement}
              shareCode={shareCode}
              captainToken={captainToken}
            />
          ))}
        </ul>
      ) : (
        <p className="text-gray-700">Nobody owes anything on this bill.</p>
      )}

      {canReopen &&
        (isConfirmingReopen ? (
          <div className="flex flex-col gap-2 rounded-lg bg-white p-3 shadow-sm">
            <p className="text-sm text-gray-700">
              Reopen this bill? People can change their items again, and these amounts are cleared.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON_CLASS}
                disabled={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                Yes, reopen it
              </button>
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={() => setIsConfirmingReopen(false)}
              >
                Keep it locked
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`${BUTTON_CLASS} self-start`}
            onClick={() => setIsConfirmingReopen(true)}
          >
            Reopen bill
          </button>
        ))}
      {reopen.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {describeError(reopen.error)}
        </p>
      )}
    </section>
  )
}

export default SettleUp
