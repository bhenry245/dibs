import { type BillFormValues, newRow, subtotalOf } from './billForm.ts'
import { formatCents } from './money.ts'
import { INPUT_CLASS } from './styles.ts'

// The items, tax, tip and fees fields, shared by typing a bill in and correcting a scanned one.
function BillFields({
  values,
  onChange,
}: {
  values: BillFormValues
  onChange: (change: Partial<BillFormValues>) => void
}) {
  const { rows } = values
  const subtotal = subtotalOf(rows)

  return (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Items</h2>
        {rows.map((row, index) => (
          <div key={row.id} className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-gray-700">
              Item {index + 1}
              <input
                className={INPUT_CLASS}
                value={row.description}
                onChange={(event) =>
                  onChange({
                    rows: rows.map((other) =>
                      other.id === row.id ? { ...other, description: event.target.value } : other,
                    ),
                  })
                }
                maxLength={255}
              />
            </label>
            <label className="flex w-24 flex-col gap-1 text-sm text-gray-700">
              Price
              <input
                className={INPUT_CLASS}
                value={row.price}
                onChange={(event) =>
                  onChange({
                    rows: rows.map((other) =>
                      other.id === row.id ? { ...other, price: event.target.value } : other,
                    ),
                  })
                }
                inputMode="decimal"
                aria-label={`Price of item ${index + 1}`}
              />
            </label>
            <button
              type="button"
              className="rounded-lg px-2 py-2 text-gray-500 hover:text-gray-900 disabled:invisible"
              onClick={() => onChange({ rows: rows.filter(({ id }) => id !== row.id) })}
              disabled={rows.length === 1}
              aria-label={`Remove item ${index + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
          onClick={() => onChange({ rows: [...rows, newRow()] })}
        >
          Add item
        </button>
        <p className="flex justify-between border-t border-gray-300 pt-3 font-semibold text-gray-900">
          <span>Subtotal</span>
          <span>{subtotal === null ? 'Check the prices' : formatCents(subtotal)}</span>
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Tax, tip, and fees</h2>
        <label className="flex items-center justify-between gap-4 text-sm text-gray-700">
          Tax
          <span className="w-24">
            <input
              className={INPUT_CLASS}
              value={values.tax}
              onChange={(event) => onChange({ tax: event.target.value })}
              inputMode="decimal"
            />
          </span>
        </label>
        <label className="flex items-center justify-between gap-4 text-sm text-gray-700">
          Fees
          <span className="w-24">
            <input
              className={INPUT_CLASS}
              value={values.fees}
              onChange={(event) => onChange({ fees: event.target.value })}
              inputMode="decimal"
            />
          </span>
        </label>
        <label className="flex items-center justify-between gap-4 text-sm text-gray-700">
          Tip
          <span className="w-24">
            <input
              className={INPUT_CLASS}
              value={values.tip}
              onChange={(event) => onChange({ tip: event.target.value })}
              inputMode="decimal"
            />
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.splitTip}
            onChange={(event) => onChange({ splitTip: event.target.checked })}
          />
          Also split the tip
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-gray-900">How people pay you</h2>
        <p className="text-sm text-gray-600">
          Optional. Anyone with the bill&apos;s QR code can see these.
        </p>
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          Venmo
          <input
            className={INPUT_CLASS}
            value={values.venmo}
            onChange={(event) => onChange({ venmo: event.target.value })}
            maxLength={50}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          Cash App
          <input
            className={INPUT_CLASS}
            value={values.cashApp}
            onChange={(event) => onChange({ cashApp: event.target.value })}
            maxLength={50}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          Zelle (phone or email)
          <input
            className={INPUT_CLASS}
            value={values.zelle}
            onChange={(event) => onChange({ zelle: event.target.value })}
            maxLength={320}
          />
        </label>
      </section>
    </>
  )
}

export default BillFields
