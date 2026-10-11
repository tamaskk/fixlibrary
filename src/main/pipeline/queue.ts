// Starts jobs as their resource has room. It knows nothing about tracks or stages:
// which job may run when is the orchestrator's to decide before it adds one.
import { RESOURCES, type Resource, type ResourceLimits } from '@shared/pipeline'

export interface JobQueueOptions<T> {
  /** Read every time a job could start, so a changed setting applies to a running queue. */
  limits: () => ResourceLimits
  resourceOf: (job: T) => Resource
  /** Runs one job. Must not reject: what a job's failure means is the caller's business. */
  run: (job: T) => Promise<void>
}

export interface JobQueue<T> {
  /** Lines the job up behind the others of its resource and starts it when there is room. */
  add: (job: T) => void
  /** Lines the job up before the others, for one that was taken back. */
  addFirst: (job: T) => void
  /** No new job starts; the running ones finish. */
  pause: () => void
  resume: () => void
  /** No new job of this resource starts; the others go on. */
  pauseResource: (resource: Resource) => void
  resumeResource: (resource: Resource) => void
  /** Takes every waiting job out and returns them. Running jobs are not touched. */
  clear: () => T[]
  /** How many jobs run now, of one resource or of all. */
  runningCount: (resource?: Resource) => number
  /** How many jobs wait for room. */
  waitingCount: () => number
}

export function createJobQueue<T>(options: JobQueueOptions<T>): JobQueue<T> {
  const waiting = Object.fromEntries(RESOURCES.map((resource) => [resource, [] as T[]])) as Record<
    Resource,
    T[]
  >
  const running = Object.fromEntries(RESOURCES.map((resource) => [resource, 0])) as Record<
    Resource,
    number
  >
  let paused = false
  const pausedResources = new Set<Resource>()

  function startWhatFits(): void {
    if (paused) return
    const limits = options.limits()
    for (const resource of RESOURCES) {
      if (pausedResources.has(resource)) continue
      // At least one at a time, whatever the setting says: a limit of zero, or one
      // that is not a number, would leave the jobs of this resource waiting forever.
      const asked = limits[resource]
      const limit = Number.isFinite(asked) ? Math.max(1, Math.trunc(asked)) : 1
      // Checked every time: the job that was just started may have paused the queue.
      while (!paused && !pausedResources.has(resource) && running[resource] < limit) {
        const job = waiting[resource].shift()
        if (job === undefined) break
        running[resource] += 1
        void options
          .run(job)
          // A run that rejects after all must not keep its place forever.
          .catch(() => {})
          .finally(() => {
            running[resource] -= 1
            startWhatFits()
          })
      }
    }
  }

  return {
    add(job) {
      waiting[options.resourceOf(job)].push(job)
      startWhatFits()
    },
    addFirst(job) {
      waiting[options.resourceOf(job)].unshift(job)
      startWhatFits()
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
      startWhatFits()
    },
    pauseResource(resource) {
      pausedResources.add(resource)
    },
    resumeResource(resource) {
      pausedResources.delete(resource)
      startWhatFits()
    },
    clear() {
      const cleared = RESOURCES.flatMap((resource) => waiting[resource].splice(0))
      return cleared
    },
    runningCount: (resource) =>
      resource === undefined
        ? RESOURCES.reduce((sum, each) => sum + running[each], 0)
        : running[resource],
    waitingCount: () => RESOURCES.reduce((sum, resource) => sum + waiting[resource].length, 0)
  }
}
