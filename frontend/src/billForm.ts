import type { BillDetails } from './api.ts'
import { parseDollars } from './money.ts'

export type ItemRow = {
  id: number
  description: string
  price: string
}

// What someone has typed so far, kept as text until the form is submitted.
export type BillFormValues = {
  rows: ItemRow[]
  tax: string
  tip: string
  fees: string
  splitTip: boolean
  venmo: string
  cashApp: string
  zelle: string
  payPal: string
}

// A stable id for each row, so React keeps typed text with the right row when one is removed.
let nextRowId = 0

export function newRow(description = '', price = ''): ItemRow {
  nextRowId += 1
  return { id: nextRowId, description, price }
}

// What the typed prices add up to so far, or null while one of them isn't a valid price. This
// only previews the form: the server still works out every amount that's saved.
export function subtotalOf(rows: ItemRow[]): number | null {
  let cents = 0
  for (const row of rows) {
    if (!row.price.trim()) continue
    const price = parseDollars(row.price)
    if (price === null) return null
    cents += price
  }
  return cents
}

// Whether guests will have any way to pay the Captain through an app.
export function hasPaymentInfo(details: BillDetails): boolean {
  return Boolean(
    details.venmo_handle || details.cashapp_tag || details.zelle_contact || details.paypal_handle,
  )
}

// Returns the bill's details, or an error message for the first thing that needs fixing.
export function buildDetails(values: BillFormValues, restaurantName: string): BillDetails | string {
  const filledRows = values.rows.filter((row) => row.description.trim() || row.price.trim())
  if (filledRows.length === 0) return 'Add at least one item.'

  const items = []
  for (const row of filledRows) {
    const description = row.description.trim()
    if (!description) return 'Every item needs a name.'
    const priceCents = parseDollars(row.price)
    if (priceCents === null) return `Enter a valid price for ${description}, like 12.50.`
    items.push({ description, price_cents: priceCents })
  }

  // Blank tax, tip or fees means none, so only typed values get checked.
  const taxCents = values.tax.trim() ? parseDollars(values.tax) : 0
  if (taxCents === null) return 'Enter a valid tax amount, like 3.12.'
  const tipCents = values.tip.trim() ? parseDollars(values.tip) : 0
  if (tipCents === null) return 'Enter a valid tip amount, like 7.80.'
  const feesCents = values.fees.trim() ? parseDollars(values.fees) : 0
  if (feesCents === null) return 'Enter a valid fees amount, like 3.11.'

  return {
    restaurant_name: restaurantName.trim() || null,
    tax_cents: taxCents,
    tip_cents: tipCents,
    fees_cents: feesCents,
    split_tip: values.splitTip,
    venmo_handle: values.venmo.trim() || null,
    cashapp_tag: values.cashApp.trim() || null,
    zelle_contact: values.zelle.trim() || null,
    paypal_handle: values.payPal.trim() || null,
    items,
  }
}
