import { useMutation } from '@tanstack/react-query'
import { type ChangeEvent, type SyntheticEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { createBill, createBillFromReceipt, describeError } from '../api.ts'
import ApiStatus from '../ApiStatus.tsx'
import BillFields from '../BillFields.tsx'
import { type BillFormValues, buildDetails, newRow } from '../billForm.ts'
import { saveIdentity } from '../identity.ts'
import { shrinkImage, UnreadableImageError } from '../image.ts'
import { INPUT_CLASS } from '../styles.ts'

function CreateBillPage() {
  const navigate = useNavigate()
  const [captainName, setCaptainName] = useState('')
  const [captainEmail, setCaptainEmail] = useState('')
  const [restaurantName, setRestaurantName] = useState('')
  const [values, setValues] = useState<BillFormValues>(() => ({
    rows: [newRow()],
    tax: '',
    tip: '',
    fees: '',
    splitTip: true,
  }))
  const [formError, setFormError] = useState<string | null>(null)
  const [scanHint, setScanHint] = useState<string | null>(null)

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

  const scan = useMutation({
    mutationFn: async (photo: File) =>
      createBillFromReceipt(await shrinkImage(photo), captainEmail.trim(), captainName.trim()),
    onSuccess: (created) => {
      saveIdentity(created.draft.bill.share_code, {
        crewMemberId: created.crew_member_id,
        token: created.token,
      })
      navigate(`/bills/${created.draft.bill.share_code}/review`)
    },
  })

  const isBusy = mutation.isPending || scan.isPending

  function handlePhotoChosen(event: ChangeEvent<HTMLInputElement>) {
    const photo = event.target.files?.[0]
    // Cleared so that choosing the same photo again after an error still counts as a change.
    event.target.value = ''
    if (!photo) return

    if (!captainName.trim() || !captainEmail.trim()) {
      setScanHint('Add your name and email first.')
      return
    }
    setScanHint(null)
    scan.mutate(photo)
  }

  function handleSubmit(event: SyntheticEvent) {
    event.preventDefault()
    const details = buildDetails(values, restaurantName)
    if (typeof details === 'string') {
      setFormError(details)
      return
    }
    setFormError(null)
    mutation.mutate({
      ...details,
      captain_email: captainEmail.trim(),
      captain_name: captainName.trim(),
    })
  }

  const errorMessage = formError ?? (mutation.error && describeError(mutation.error))

  let scanMessage = scanHint
  if (!scanMessage && scan.error) {
    scanMessage =
      scan.error instanceof UnreadableImageError ? scan.error.message : describeError(scan.error)
  }

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
          </section>

          <section className="flex flex-col gap-3">
            <label
              className={`cursor-pointer rounded-lg bg-gray-900 px-4 py-3 text-center font-semibold text-white focus-within:outline-2 focus-within:outline-offset-2 hover:bg-gray-700 ${
                isBusy ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              {scan.isPending ? 'Reading your receipt…' : 'Scan receipt'}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={handlePhotoChosen}
                disabled={isBusy}
              />
            </label>
            {scan.isPending && (
              <p role="status" className="text-center text-sm text-gray-600">
                This can take up to a minute. Keep this page open.
              </p>
            )}
            {scanMessage && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                {scanMessage}
              </p>
            )}
          </section>

          <p className="text-center text-sm font-medium text-gray-600">or type it in</p>

          <section className="flex flex-col gap-3">
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

          <BillFields
            values={values}
            onChange={(change) => setValues((current) => ({ ...current, ...change }))}
          />

          {errorMessage && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            className="rounded-lg border border-gray-900 bg-white px-4 py-3 font-semibold text-gray-900 hover:bg-gray-100 disabled:opacity-50"
            disabled={isBusy}
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
