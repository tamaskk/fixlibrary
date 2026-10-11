import { describe, expect, it, vi } from 'vitest'
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
    counts: { total: 100, done: 0, failed: 0, skipped: 0, running: 1 },
    stages: [],
    startedAt: 0,
    remainingMs: null,
    ...changes
  }
}

function done(report: RunProgress): number {
  return report.counts.done
}

describe('createRunProgressSender', () => {
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
})
