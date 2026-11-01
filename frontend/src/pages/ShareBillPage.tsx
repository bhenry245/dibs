import { useParams } from 'react-router'

// A placeholder until the QR screen is built, so creating a bill has somewhere to land.
function ShareBillPage() {
  const { shareCode } = useParams()

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-2 bg-gray-50 p-6">
      <h1 className="text-3xl font-bold tracking-tight text-gray-900">Bill created</h1>
      <p className="text-gray-600">
        Share code: <span className="font-mono break-all text-gray-900">{shareCode}</span>
      </p>
    </main>
  )
}

export default ShareBillPage
