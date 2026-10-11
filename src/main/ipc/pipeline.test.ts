import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunProgress } from '@shared/pipeline'

// The module registers nothing by being imported, but it imports Electron.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }))

const { createRunProgressSender } = await import('./pipeline')

function progress(changes: Partial<RunProgress> = {}): RunProgress {
  return {
    batchId: 1,
    phase: 'compute',
    state: 'running',
    outcome: null,
    pauseReason: null,
    claudeRetryAt: null,
    counts: { total: 100, done: 0, failed: 0, skipped: 0, running: 1 },
    stages: [],
    tracks: { total: 20, failed: 0 },
    elapsedMs: 0,
    remainingMs: null,
    ...changes
  }
}

function done(report: RunProgress): number {
  return report.counts.done
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRunProgressSender', () => {
  it('still sends the newest report that it held back, when its time has come', () => {
    // Arrange
    vi.useFakeTimers()
    const sent: RunProgress[] = []
    const send = createRunProgressSender((report) => sent.push(report))
    const withDone = (count: number): RunProgress =>
      progress({ counts: { total: 40, done: count, failed: 0, skipped: 0, running: 1 } })

    // Act: three jobs finish within 100 ms, then nothing happens for minutes.
    send(withDone(37))
    vi.advanceTimersByTime(50)
    send(withDone(38))
    vi.advanceTimersByTime(50)
    send(withDone(39))
    vi.advanceTimersByTime(10 * 60_000)

    // Assert
    expect(sent.map(done)).toEqual([37, 39])
  })

  it('drops a held report when a report that must not wait overtakes it', () => {
    // Arrange
    vi.useFakeTimers()
    const sent: RunProgress[] = []
    const send = createRunProgressSender((report) => sent.push(report))

    // Act
    send(progress())
    send(progress({ counts: { total: 40, done: 5, failed: 0, skipped: 0, running: 1 } }))
    send(progress({ state: 'finished', outcome: 'preview' }))
    vi.advanceTimersByTime(60_000)

    // Assert
    expect(sent.map((report) => report.state)).toEqual(['running', 'finished'])
  })

  it('passes on at most four reports a second while nothing about the run itself changes', () => {
    // Arrange
    let time = 0
    const sent: RunProgress[] = []
    const send = createRunProgressSender(
      (report) => sent.push(report),
      () => time
    )

    // Act
    for (let step = 0; step < 100; step += 1) {
      send(progress({ counts: { total: 100, done: step, failed: 0, skipped: 0, running: 1 } }))
      time += 20
    }

    // Assert: 100 reports in two seconds.
    expect(sent.map(done)).toEqual([0, 13, 26, 39, 52, 65, 78, 91])
    expect(sent.length).toBeLessThanOrEqual(8)
  })

  it('never holds back a report that says the run paused, went on or ended', () => {
    // Arrange
    const sent: RunProgress[] = []
    const send = createRunProgressSender(
      (report) => sent.push(report),
      () => 0
    )

    // Act: all in the same instant.
    send(progress())
    send(progress())
    send(progress({ state: 'paused', pauseReason: 'user' }))
    send(progress({ state: 'paused', pauseReason: 'user' }))
    send(progress({ state: 'running' }))
    send(progress({ state: 'paused', pauseReason: 'offline' }))
    send(progress({ state: 'finished', outcome: 'preview' }))

    // Assert
    expect(sent.map((report) => [report.state, report.pauseReason])).toEqual([
      ['running', null],
      ['paused', 'user'],
      ['running', null],
      ['paused', 'offline'],
      ['finished', null]
    ])
  })

  it('passes the first report of the next run on at once', () => {
    // Arrange
    const sent: RunProgress[] = []
    const send = createRunProgressSender(
      (report) => sent.push(report),
      () => 0
    )

    // Act
    send(progress({ batchId: 1 }))
    send(progress({ batchId: 2 }))
    send(progress({ batchId: 2, phase: 'apply' }))

    // Assert
    expect(sent.map((report) => [report.batchId, report.phase])).toEqual([
      [1, 'compute'],
      [2, 'compute'],
      [2, 'apply']
    ])
  })

  it('passes on at once that the Claude limit was reached, and that Claude is asked again', () => {
    // Arrange
    const sent: RunProgress[] = []
    let time = 0
    const send = createRunProgressSender(
      (report) => sent.push(report),
      () => time
    )
    send(progress())

    // Act
    time = 10
    send(progress({ claudeRetryAt: 900_000 }))
    time = 20
    send(progress({ claudeRetryAt: null }))

    // Assert
    expect(sent.map((report) => report.claudeRetryAt)).toEqual([null, 900_000, null])
  })
})
