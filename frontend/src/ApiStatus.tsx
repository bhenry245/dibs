import { useEffect, useState } from 'react'

type Status = 'checking' | 'ok' | 'down'

const STATUS_LABEL: Record<Status, string> = {
  checking: 'Checking API…',
  ok: 'API connected',
  down: 'API unreachable',
}

const STATUS_DOT: Record<Status, string> = {
  checking: 'bg-gray-400',
  ok: 'bg-green-500',
  down: 'bg-red-500',
}

function ApiStatus() {
  const [status, setStatus] = useState<Status>('checking')

  // Proves the whole dev stack is wired up: browser -> Vite proxy -> FastAPI.
  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { status: string }) => setStatus(body.status === 'ok' ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
  }, [])

  return (
    <p className="flex items-center justify-center gap-2 text-sm text-gray-700">
      <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABEL[status]}
    </p>
  )
}

export default ApiStatus
