import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PythonRuntimeState } from '@shared/python-runtime'
import { createRuntimeStateSender } from './python-runtime'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRuntimeStateSender', () => {
  it('sends a change of status at once and the progress four times a second at most', () => {
    // Arrange
    const sent: PythonRuntimeState[] = []
    const send = createRuntimeStateSender((state) => sent.push(state))

    // Act
    send({ status: 'unpacking', fraction: 0 })
    for (let step = 1; step <= 10; step += 1) send({ status: 'unpacking', fraction: step / 20 })
    const beforeTheTimer = sent.length
    vi.advanceTimersByTime(250)
    send({ status: 'ready', fraction: 1 })

    // Assert
    expect(beforeTheTimer).toBe(1)
    expect(sent).toEqual([
      { status: 'unpacking', fraction: 0 },
      { status: 'unpacking', fraction: 0.5 },
      { status: 'ready', fraction: 1 }
    ])
  })
})
