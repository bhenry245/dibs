import { useEffect, useState } from 'react'

type ApiStatus = 'checking' | 'ok' | 'down'

const STATUS_LABEL: Record<ApiStatus, string> = {
  checking: 'Checking API…',
  ok: 'API connected',
  down: 'API unreachable',
}

const STATUS_DOT: Record<ApiStatus, string> = {
  checking: 'bg-gray-400',
  ok: 'bg-green-500',
  down: 'bg-red-500',
}

function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')

  // Proves the whole dev stack is wired up: browser -> Vite proxy -> FastAPI.
  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { status: string }) => setApiStatus(body.status === 'ok' ? 'ok' : 'down'))
      .catch(() => setApiStatus('down'))
  }, [])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
      <h1 className="text-5xl font-bold tracking-tight text-gray-900">Dibs</h1>
      <p className="text-center text-gray-600">Split the bill at the table.</p>
      <p className="flex items-center gap-2 text-sm text-gray-700">
        <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[apiStatus]}`} />
        {STATUS_LABEL[apiStatus]}
      </p>
    </main>
  )
}

export default App
