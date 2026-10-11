// What a run of the pipeline is made of, and what the app says about it while it runs.
import { z } from 'zod'

/** What a stage needs to run. Each has its own limit on how many jobs run at once. */
export const RESOURCES = ['cpu', 'gpu', 'network', 'claude', 'io'] as const
export type Resource = (typeof RESOURCES)[number]

/** How many jobs of each resource may run at the same time. */
export type ResourceLimits = Record<Resource, number>

/**
 * The limits that do not depend on the machine. `cpu` is the worker count of the
 * settings and is added where the limits are used.
 */
export const FIXED_RESOURCE_LIMITS: Omit<ResourceLimits, 'cpu'> = {
  // Demucs: one model in memory, one track at a time.
  gpu: 1,
  // Requests in flight. How often each lookup service may be asked is set per service.
  network: 4,
  // As many as one call to Claude holds: the jobs that run together are asked about
  // together. The calls themselves go one at a time (`pipeline/claude.ts`).
  claude: 20,
  // Copies and renames on the external drive.
  io: 2
}

export const JOB_PHASES = ['compute', 'apply'] as const
/** Compute proposes and touches no file; apply writes, and runs only after approval. */
export type JobPhase = (typeof JOB_PHASES)[number]

const MAX_STAGE_NAME_LENGTH = 40

export const runStartSchema = z.strictObject({
  trackIds: z.array(z.number().int().positive()).min(1),
  /** The stages to run. The stages they depend on are added by the app. */
  stages: z.array(z.string().min(1).max(MAX_STAGE_NAME_LENGTH)).min(1).max(50)
})

export type RunStart = z.input<typeof runStartSchema>

/** How many jobs are in which state. */
export interface JobCounts {
  total: number
  done: number
  failed: number
  skipped: number
  running: number
}

export interface RunProgress {
  batchId: number
  phase: JobPhase
  /**
   * `paused`: nothing new starts, what runs finishes. `finished`: the phase is over;
   * this is the last report of a run.
   */
  state: 'running' | 'paused' | 'finished'
  /** How the phase ended; null until it has. `preview` waits for the user's approval. */
  outcome: 'preview' | 'applied' | 'cancelled' | null
  /** Why the run is paused: by the user, or because the library's drive went away. */
  pauseReason: 'user' | 'offline' | null
  /**
   * Set while the Claude usage limit is reached: when the app asks Claude again, in
   * ms since the epoch. The steps that need Claude wait; the others go on.
   */
  claudeRetryAt: number | null
  /** The jobs of the phase that is running. */
  counts: JobCounts
  /** The same per stage, in the order the stages run. */
  stages: (JobCounts & { stage: string })[]
  /** The tracks of the batch, and how many of them a stage of this phase failed for. */
  tracks: { total: number; failed: number }
  /**
   * How long the phase has been working in this session of the app, as of this
   * report. The time a run is paused does not count.
   */
  elapsedMs: number
  /** An estimate of the time left, or null while too little has finished to tell. */
  remainingMs: number | null
}

/** What the page needs to know about runs when it opens. */
export interface PipelineState {
  /** The names of the functions that can be asked for, in the order to offer them. */
  functions: string[]
  /** The run that is active now, or null. */
  progress: RunProgress | null
}
