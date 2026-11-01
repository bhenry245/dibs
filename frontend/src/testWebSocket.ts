// A stand-in for the browser's WebSocket. It never connects by itself, so pages under test behave as
// if the connection is down unless a test opens it.
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  closed = false
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.closed = true
  }

  open() {
    this.onopen?.()
  }

  receive() {
    this.onmessage?.()
  }

  drop(code = 1006) {
    this.onclose?.({ code })
  }
}
