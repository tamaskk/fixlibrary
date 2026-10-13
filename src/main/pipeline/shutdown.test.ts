import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForFileWork, type FileWork } from './shutdown'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** File work that ends when the test says so. */
function working(undoing = false): FileWork & { finish: () => void } {
  let busy = true
  let done: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  return {
    busy: () => busy,
    undoing: () => undoing && busy,
    settled: () => settled,
    finish: () => {
      busy = false
      done()
    }
  }
}

describe('waitForFileWork', () => {
  it('goes on at once when no file is being worked on', async () => {
    // Arrange
    const idle: FileWork = {
      busy: () => false,
      undoing: () => false,
      settled: () => new Promise(() => {})
    }

    // Act
    const ended = await waitForFileWork(idle, 15_000)

    // Assert
    expect(ended).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the step a stage is in, and leaves no timer behind', async () => {
    // Arrange
    const files = working()
    let ended: boolean | null = null

    // Act
    void waitForFileWork(files, 15_000).then((result) => {
      ended = result
    })
    await vi.advanceTimersByTimeAsync(5000)
    const whileWorking = ended
    files.finish()
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(whileWorking).toBeNull()
    expect(ended).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an undo however long it takes, and says that it does', async () => {
    // Arrange
    const files = working(true)
    const told = vi.fn()
    let ended: boolean | null = null

    // Act
    void waitForFileWork(files, 15_000, told).then((result) => {
      ended = result
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const afterTenMinutes = ended
    files.finish()
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(told).toHaveBeenCalledTimes(1)
    expect(afterTenMinutes).toBeNull()
    expect(ended).toBe(true)
  })

  it('gives what is left after an undo only the time it was given', async () => {
    // Arrange: an undo that ends, and other work that does not.
    let undoing = true
    let endUndo: () => void = () => {}
    const undone = new Promise<void>((resolve) => {
      endUndo = resolve
    })
    const files: FileWork = {
      busy: () => true,
      undoing: () => undoing,
      settled: () => (undoing ? undone : new Promise(() => {}))
    }

    // Act
    const waiting = waitForFileWork(files, 15_000)
    await vi.advanceTimersByTimeAsync(60_000)
    undoing = false
    endUndo()
    await vi.advanceTimersByTimeAsync(15_000)

    // Assert
    await expect(waiting).resolves.toBe(false)
  })

  it('gives up after the time it was given, and says so', async () => {
    // Arrange
    const files = working()

    // Act
    const waiting = waitForFileWork(files, 15_000)
    await vi.advanceTimersByTimeAsync(15_000)

    // Assert
    await expect(waiting).resolves.toBe(false)
  })

  it('waits for work that begins the moment the work before it ends', async () => {
    // Arrange: when the step of a stage ends, the deletion of older backups begins.
    let busy = true
    let end: () => void = () => {}
    let settled = new Promise<void>((resolve) => (end = resolve))
    const files: FileWork = { busy: () => busy, undoing: () => false, settled: () => settled }
    let ended: boolean | null = null

    // Act
    void waitForFileWork(files, 15_000).then((result) => {
      ended = result
    })
    const endFirst = end
    settled = new Promise<void>((resolve) => (end = resolve))
    endFirst()
    await vi.advanceTimersByTimeAsync(1000)
    const whileSecond = ended
    busy = false
    end()
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(whileSecond).toBeNull()
    expect(ended).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
