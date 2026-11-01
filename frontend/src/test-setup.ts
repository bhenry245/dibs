import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { FakeWebSocket } from './testWebSocket.ts'

// Pages open a live connection, and tests must never try to reach a real server.
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

// Unmount whatever each test rendered, so tests can't see each other's DOM.
afterEach(cleanup)
