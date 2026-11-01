import type { PersonTotal } from './api.ts'
import { formatCents } from './money.ts'

// One person's total and how it breaks down. Every amount comes from the API, so the cent-exact
// math only lives in split_bill.
function TotalSummary({ person, isCaptain }: { person: PersonTotal; isCaptain: boolean }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {isCaptain ? 'Your total' : 'You owe'}
        </h2>
        <p className="text-2xl font-bold text-gray-900">{formatCents(person.total_cents)}</p>
      </div>
      <dl className="flex flex-col gap-1 text-sm text-gray-700">
        <div className="flex justify-between">
          <dt>Your items</dt>
          <dd>{formatCents(person.claimed_cents)}</dd>
        </div>
        {person.unclaimed_cents > 0 && (
          <div className="flex justify-between">
            <dt>Unclaimed, counts as yours</dt>
            <dd>{formatCents(person.unclaimed_cents)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt>Your tax</dt>
          <dd>{formatCents(person.tax_cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Your tip</dt>
          <dd>{formatCents(person.tip_cents)}</dd>
        </div>
        {person.fees_cents > 0 && (
          <div className="flex justify-between">
            <dt>Your fees</dt>
            <dd>{formatCents(person.fees_cents)}</dd>
          </div>
        )}
      </dl>
    </>
  )
}

export default TotalSummary
