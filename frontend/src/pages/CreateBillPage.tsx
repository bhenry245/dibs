import { useMutation } from '@tanstack/react-query'
import { type SyntheticEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { type BillCreate, createBill, describeError } from '../api.ts'
import ApiStatus from '../ApiStatus.tsx'
import { saveIdentity } from '../identity.ts'
import { parseDollars } from '../money.ts'
import { INPUT_CLASS } from '../styles.ts'

type ItemRow = {
  id: number
  description: string
  price: string
}

// A stable id for each row, so React keeps typed text with the right row when one is removed.
let nextRowId = 0

function newRow(): ItemRow {
  nextRowId += 1
  return { id: nextRowId, description: '', price: '' }
}

function CreateBillPage() {
  const navigate = useNavigate()
  const [captainName, setCaptainName] = useState('')
  const [captainEmail, setCaptainEmail] = useState('')
  const [restaurantName, setRestaurantName] = useState('')
  const [rows, setRows] = useState<ItemRow[]>(() => [newRow()])
  const [tax, setTax] = useState('')
  const [tip, setTip] = useState('')
  const [splitTip, setSplitTip] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: createBill,
    onSuccess: (created) => {
      saveIdentity(created.bill.share_code, {
        crewMemberId: created.crew_member_id,
        token: created.token,
      })
      navigate(`/bills/${created.bill.share_code}/share`)
    },
  })

  function updateRow(id: number, change: Partial<ItemRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)))
  }

  // Returns the request body, or an error message for the first thing that needs fixing.
  function buildBody(): BillCreate | string {
    const filledRows = rows.filter((row) => row.description.trim() || row.price.trim())
    if (filledRows.length === 0) return 'Add at least one item.'

    const items = []
    for (const row of filledRows) {
      const description = row.description.trim()
      if (!description) return 'Every item needs a name.'
      const priceCents = parseDollars(row.price)
      if (priceCents === null) return `Enter a valid price for ${description}, like 12.50.`
      items.push({ description, price_cents: priceCents })
    }

    // Blank tax or tip means none, so only typed values get checked.
    const taxCents = tax.trim() ? parseDollars(tax) : 0
    if (taxCents === null) return 'Enter a valid tax amount, like 3.12.'
    const tipCents = tip.trim() ? parseDollars(tip) : 0
    if (tipCents === null) return 'Enter a valid tip amount, like 7.80.'

    return {
      captain_email: captainEmail.trim(),
      captain_name: captainName.trim(),
      restaurant_name: restaurantName.trim() || null,
      tax_cents: taxCents,
      tip_cents: tipCents,
      split_tip: splitTip,
      items,
    }
  }

  function handleSubmit(event: SyntheticEvent) {
    event.preventDefault()
    const body = buildBody()
    if (typeof body === 'string') {
      setFormError(body)
      return
    }
    setFormError(null)
    mutation.mutate(body)
  }

  const errorMessage = formError ?? (mutation.error && describeError(mutation.error))

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <header>
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">Dibs</h1>
          <p className="text-gray-600">Split the bill at the table.</p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-gray-900">About you</h2>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Your name
              <input
                className={INPUT_CLASS}
                value={captainName}
                onChange={(event) => setCaptainName(event.target.value)}
                autoComplete="name"
                maxLength={100}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Your email
              <input
                className={INPUT_CLASS}
                type="email"
                value={captainEmail}
                onChange={(event) => setCaptainEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Restaurant (optional)
              <input
                className={INPUT_CLASS}
                value={restaurantName}
                onChange={(event) => setRestaurantName(event.target.value)}
                maxLength={200}
              />
            </label>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Items</h2>
            {rows.map((row, index) => (
              <div key={row.id} className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-gray-700">
                  Item {index + 1}
                  <input
                    className={INPUT_CLASS}
                    value={row.description}
                    onChange={(event) => updateRow(row.id, { description: event.target.value })}
                    maxLength={255}
                  />
                </label>
                <label className="flex w-24 flex-col gap-1 text-sm text-gray-700">
                  Price
                  <input
                    className={INPUT_CLASS}
                    value={row.price}
                    onChange={(event) => updateRow(row.id, { price: event.target.value })}
                    inputMode="decimal"
                    aria-label={`Price of item ${index + 1}`}
                  />
                </label>
                <button
                  type="button"
                  className="rounded-lg px-2 py-2 text-gray-500 hover:text-gray-900 disabled:invisible"
                  onClick={() => setRows((current) => current.filter(({ id }) => id !== row.id))}
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
              onClick={() => setRows((current) => [...current, newRow()])}
            >
              Add item
            </button>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Tax and tip</h2>
            <div className="flex gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-gray-700">
                Tax
                <input
                  className={INPUT_CLASS}
                  value={tax}
                  onChange={(event) => setTax(event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-gray-700">
                Tip
                <input
                  className={INPUT_CLASS}
                  value={tip}
                  onChange={(event) => setTip(event.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={splitTip}
                onChange={(event) => setSplitTip(event.target.checked)}
              />
              Also split the tip
            </label>
          </section>

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
            {mutation.isPending ? 'Creating…' : 'Create bill'}
          </button>
        </form>

        <ApiStatus />
      </div>
    </main>
  )
}

export default CreateBillPage
