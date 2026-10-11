import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_EVENTS } from './ipc'

describe('IPC_CHANNELS', () => {
  it('uses unique, namespaced channel names', () => {
    // Arrange
    const channels = [...Object.values(IPC_CHANNELS), ...Object.values(IPC_EVENTS)]

    // Act
    const unique = new Set(channels)

    // Assert
    expect(unique.size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^[a-z-]+:[a-zA-Z]+$/)
    }
  })
})
