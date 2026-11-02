import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { POLL_INTERVAL_MS, RECONNECT_MAX_MS, LIVE_POLL_INTERVAL_MS } from './api.ts'

// Means the bill doesn't exist or isn't visible yet (CLOSE_BILL_NOT_FOUND in live.py), so trying
// again won't help.
const CLOSE_BILL_NOT_FOUND = 4404

// Keeps a bill's data fresh: the server says when it changed, and this refetches it. Returns how often
// the page should still check by itself, which is often only while the connection is down, so
// flaky restaurant Wi-Fi slows updates down rather than stopping them.
export function useLiveBill(shareCode: string): number {
  const queryClient = useQueryClient()
  const [isLive, setIsLive] = useState(false)

  useEffect(() => {
    let socket: WebSocket
    let attempts = 0
    let retry: ReturnType<typeof setTimeout>
    let stopped = false

    function refresh() {
      queryClient.invalidateQueries({ queryKey: ['bill', shareCode] })
      queryClient.invalidateQueries({ queryKey: ['totals', shareCode] })
      queryClient.invalidateQueries({ queryKey: ['preview', shareCode] })
    }

    function connect() {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(
        `${scheme}://${window.location.host}/api/bills/${encodeURIComponent(shareCode)}/live`,
      )
      socket.onopen = () => {
        attempts = 0
        setIsLive(true)
        // Anything could have changed while disconnected.
        refresh()
      }
      socket.onmessage = refresh
      socket.onclose = (event) => {
        setIsLive(false)
        if (stopped || event.code === CLOSE_BILL_NOT_FOUND) return
        // Waits longer each time, so a server that's down isn't flooded when it comes back.
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts, RECONNECT_MAX_MS))
        attempts += 1
      }
    }

    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      socket.close()
    }
  }, [queryClient, shareCode])

  return isLive ? LIVE_POLL_INTERVAL_MS : POLL_INTERVAL_MS
}
