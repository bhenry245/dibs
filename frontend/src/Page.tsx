import type { ReactNode } from 'react'

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="mx-auto flex max-w-md flex-col gap-6">{children}</div>
    </main>
  )
}

export default Page
