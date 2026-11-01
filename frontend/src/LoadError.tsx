import { describeError } from './api.ts'

function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
        {describeError(error)}
      </p>
      <button
        type="button"
        className="self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  )
}

export default LoadError
