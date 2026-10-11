import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resource, ResourceLimits } from '@shared/pipeline'
import { createJobQueue, type JobQueue } from './queue'

interface FakeJob {
  name: string
  resource: Resource
  ms: number
}

let limits: ResourceLimits
let runningNow: Record<Resource, number>
let mostAtOnce: Record<Resource, number>
let started: string[]
let finished: string[]

function counters(): Record<Resource, number> {
  return { cpu: 0, gpu: 0, network: 0, claude: 0, io: 0 }
}

function queue(): JobQueue<FakeJob> {
  return createJobQueue<FakeJob>({
    limits: () => limits,
    resourceOf: (job) => job.resource,
    run: async (job) => {
      started.push(job.name)
      runningNow[job.resource] += 1
      mostAtOnce[job.resource] = Math.max(mostAtOnce[job.resource], runningNow[job.resource])
      await new Promise((resolve) => setTimeout(resolve, job.ms))
      runningNow[job.resource] -= 1
      finished.push(job.name)
    }
  })
}

function job(name: string, resource: Resource = 'cpu', ms = 100): FakeJob {
  return { name, resource, ms }
}

beforeEach(() => {
  vi.useFakeTimers()
  limits = { cpu: 3, gpu: 1, network: 4, claude: 1, io: 2 }
  runningNow = counters()
  mostAtOnce = counters()
  started = []
  finished = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createJobQueue', () => {
  it('never runs more jobs of a resource at once than its limit, across 200 tracks', async () => {
    // Arrange
    const jobs = queue()
    for (let track = 0; track < 200; track += 1) {
      jobs.add(job(`cpu-${track}`, 'cpu', 30 + (track % 7)))
      jobs.add(job(`gpu-${track}`, 'gpu', 50))
      jobs.add(job(`io-${track}`, 'io', 10))
    }

    // Act
    await vi.runAllTimersAsync()

    // Assert
    expect(finished).toHaveLength(600)
    expect(mostAtOnce).toEqual({ cpu: 3, gpu: 1, network: 0, claude: 0, io: 2 })
  })

  it('starts the jobs of a resource in the order they were added', async () => {
    // Arrange
    limits.cpu = 1
    const jobs = queue()
    for (const name of ['a', 'b', 'c']) jobs.add(job(name))

    // Act
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('lets a job of one resource run while another resource is full', async () => {
    // Arrange
    const jobs = queue()
    jobs.add(job('demucs-1', 'gpu', 1000))
    jobs.add(job('demucs-2', 'gpu', 1000))
    jobs.add(job('bpm', 'cpu', 10))

    // Act
    await vi.advanceTimersByTimeAsync(10)

    // Assert
    expect(finished).toEqual(['bpm'])
    expect(jobs.runningCount('gpu')).toBe(1)
    expect(jobs.waitingCount()).toBe(1)
  })

  it('starts nothing new while paused, lets what runs finish, and goes on after resume', async () => {
    // Arrange
    limits.cpu = 2
    const jobs = queue()
    for (const name of ['a', 'b', 'c', 'd']) jobs.add(job(name))

    // Act
    jobs.pause()
    await vi.advanceTimersByTimeAsync(1000)
    const whilePaused = { finished: [...finished], running: jobs.runningCount() }
    jobs.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(whilePaused).toEqual({ finished: ['a', 'b'], running: 0 })
    expect(finished).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes the waiting jobs out when cleared and leaves the running ones alone', async () => {
    // Arrange
    limits.cpu = 1
    const jobs = queue()
    for (const name of ['a', 'b', 'c']) jobs.add(job(name))

    // Act
    const cleared = jobs.clear()
    await vi.runAllTimersAsync()

    // Assert
    expect(cleared.map((entry) => entry.name)).toEqual(['b', 'c'])
    expect(finished).toEqual(['a'])
  })

  it('runs a job that was put first before the ones already waiting', async () => {
    // Arrange
    limits.cpu = 1
    const jobs = queue()
    for (const name of ['a', 'b']) jobs.add(job(name))

    // Act
    jobs.addFirst(job('urgent'))
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual(['a', 'urgent', 'b'])
  })

  it('applies a changed limit to the jobs that have not started', async () => {
    // Arrange
    limits.cpu = 1
    const jobs = queue()
    for (let index = 0; index < 6; index += 1) jobs.add(job(`job-${index}`))

    // Act
    limits.cpu = 4
    await vi.advanceTimersByTimeAsync(100)
    const afterFirst = jobs.runningCount('cpu')
    await vi.runAllTimersAsync()

    // Assert
    expect(afterFirst).toBe(4)
    expect(finished).toHaveLength(6)
  })

  it('runs one job at a time for a resource whose limit is zero', async () => {
    // Arrange
    limits.cpu = 0
    const jobs = queue()
    for (const name of ['a', 'b']) jobs.add(job(name))

    // Act
    await vi.runAllTimersAsync()

    // Assert
    expect(finished).toEqual(['a', 'b'])
    expect(mostAtOnce.cpu).toBe(1)
  })

  it('runs one job at a time for a resource whose limit is not a number', async () => {
    // Arrange
    limits.cpu = Number.NaN
    const jobs = queue()
    for (const name of ['a', 'b']) jobs.add(job(name))

    // Act
    await vi.runAllTimersAsync()

    // Assert
    expect(finished).toEqual(['a', 'b'])
  })

  it('starts nothing more, of any resource, once a job has paused the queue while starting', async () => {
    // Arrange
    const startedHere: string[] = []
    const jobs: JobQueue<FakeJob> = createJobQueue<FakeJob>({
      limits: () => limits,
      resourceOf: (entry) => entry.resource,
      run: async (entry) => {
        startedHere.push(entry.name)
        if (entry.name === 'pauses') {
          jobs.pause()
          jobs.addFirst(entry)
        }
      }
    })
    jobs.pause()
    jobs.add(job('pauses', 'cpu'))
    jobs.add(job('cpu-2', 'cpu'))
    jobs.add(job('io-1', 'io'))

    // Act
    jobs.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(startedHere).toEqual(['pauses'])
    expect(jobs.waitingCount()).toBe(3)
  })

  it('gives the place of a job back when its run rejects', async () => {
    // Arrange
    limits.cpu = 1
    const jobs = createJobQueue<FakeJob>({
      limits: () => limits,
      resourceOf: (entry) => entry.resource,
      run: async (entry) => {
        started.push(entry.name)
        if (entry.name === 'bad') throw new Error('a run must not reject, but this one does')
      }
    })

    // Act
    jobs.add(job('bad'))
    jobs.add(job('good'))
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual(['bad', 'good'])
    expect(jobs.runningCount()).toBe(0)
  })
})
