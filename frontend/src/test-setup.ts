import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmount whatever each test rendered, so tests can't see each other's DOM.
afterEach(cleanup)
