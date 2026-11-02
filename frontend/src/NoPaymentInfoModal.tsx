import { useEffect, useRef } from 'react'
import { PAYMENT_FIELD_ID } from './BillFields.tsx'

// Asked before guests can see a bill with no way to pay the Captain back. Adding payment info is
// the big button, and skipping takes a deliberate tap, because most people are better off with it.
function NoPaymentInfoModal({ onContinue, onAdd }: { onContinue: () => void; onAdd: () => void }) {
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialog.current?.focus()
  }, [])

  function addPaymentInfo() {
    onAdd()
    document.getElementById(PAYMENT_FIELD_ID)?.focus()
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="no-payment-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') addPaymentInfo()
        }}
        className="flex w-full max-w-md flex-col gap-4 rounded-lg bg-white p-4 outline-none"
      >
        <h2 id="no-payment-title" className="text-xl font-bold text-gray-900">
          How will people pay you back?
        </h2>
        <p className="text-gray-700">
          You haven&apos;t added Venmo, Cash App, Zelle or PayPal. With one, everyone gets a quick
          way to pay you. Without one, you&apos;ll need to collect from each person yourself.
        </p>
        <button
          type="button"
          className="rounded-lg bg-gray-900 px-4 py-3 font-semibold text-white hover:bg-gray-700"
          onClick={addPaymentInfo}
        >
          Add payment info
        </button>
        <button
          type="button"
          className="py-1 text-sm font-medium text-gray-600 underline hover:text-gray-900"
          onClick={onContinue}
        >
          I&apos;ll collect another way
        </button>
      </div>
    </div>
  )
}

export default NoPaymentInfoModal
