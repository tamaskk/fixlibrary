import { basename, dirname, extname, join } from 'path'
import type { Track } from '../../db/tracks'
import { AppError } from '@shared/errors'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import type { Stage } from './stage'

const DEFAULT_DEMO_STAGE_MS = 200

export interface DemoStageOptions {
  /**
   * Whether the stand-in rename may touch the file at this path. It renames real
   * files, so whoever adds these stages says which ones are only generated test
   * files. Without it, the stage renames nothing.
   */
  mayRename?: (path: string) => boolean
}

/** Waits, and stops waiting as soon as the stage is told to stop. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = (): void => {
      clearTimeout(timer)
      reject(new Error('the demo stage was stopped'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopped)
      resolve()
    }, ms)
    if (signal.aborted) stopped()
    else signal.addEventListener('abort', stopped, { once: true })
  })
}

/** `Artist - Title (Mix).ext`, without the characters a file name cannot hold. */
function demoFileName(track: Track, values: Partial<Record<PreviewField, PreviewValue>>): string {
  const part = (value: PreviewValue | undefined): string =>
    String(value ?? '')
      .replace(/[/:\p{Cc}]/gu, '-')
      .replace(/^\.+/, '')
      .trim()
  const artist = part(values.artist)
  const title = part(values.title)
  const mix = part(values.mix)
  const name = [artist, title].filter((text) => text !== '').join(' - ')
  const extension = extname(track.path)
  if (name === '') return basename(track.path)
  const whole = `${name}${mix === '' ? '' : ` (${mix})`}`.normalize('NFC')
  // Cut by character, never through the middle of one.
  return [...whole].slice(0, 200).join('').trim() + extension
}

/** What the stand-in lookup "finds" for a track: made up from its file name. */
function demoLookup(track: Track): Proposal {
  const stem = basename(track.path, extname(track.path))
  const artist = track.artist ?? 'Demo Artist'
  const title = track.title ?? stem.replace(/[-_]+/g, ' ')
  // Every fifth track is a guess the user should look at.
  const confidence = track.id % 5 === 0 ? 0.6 : 0.95
  return {
    fields: {
      artist: { value: artist, source: 'lookup', confidence },
      title: { value: title, source: 'lookup', confidence },
      fileName: { value: demoFileName(track, { artist, title, mix: track.mix }), source: 'lookup' }
    }
  }
}

/**
 * Stand-ins for the real stages, which arrive from T-013 on. They read no file and
 * call nothing; two of them only wait and propose made-up values, so a run can be
 * started, paused, cancelled, previewed and approved in the running app. The third
 * one renames the file to the proposed name, through the same backup and undo as a
 * real stage, and only where `mayRename` allows it. They are only ever added in
 * development (see `src/main/index.ts`).
 */
export function createDemoStages(
  ms: number = DEFAULT_DEMO_STAGE_MS,
  options: DemoStageOptions = {}
): Stage[] {
  const mayRename = options.mayRename ?? ((): boolean => false)
  return [
    {
      name: 'demoAnalyze',
      phase: 'compute',
      resource: 'cpu',
      dependsOn: [],
      selectable: true,
      timeoutMs: ms + 30_000,
      run: async ({ signal }, track) => {
        await wait(ms, signal)
        return {
          proposal: {
            fields: { energy: { value: (track.id % 10) + 1, source: 'analysis' } }
          }
        }
      }
    },
    {
      name: 'demoLookup',
      phase: 'compute',
      resource: 'network',
      dependsOn: ['demoAnalyze'],
      selectable: true,
      timeoutMs: ms + 30_000,
      run: async ({ signal }, track) => {
        await wait(ms, signal)
        return { proposal: demoLookup(track) }
      },
      recompute: (track, values) => ({
        fields: { fileName: { value: demoFileName(track, values), source: 'lookup' } }
      })
    },
    {
      name: 'demoRename',
      phase: 'apply',
      resource: 'io',
      dependsOn: ['demoLookup'],
      selectable: false,
      timeoutMs: 60_000,
      run: async ({ files, proposal }, track) => {
        if (!files) throw new Error('an apply stage must be given its files')
        const fileName = proposal.fields?.fileName?.value
        if (typeof fileName !== 'string') return
        // A stand-in must never rename a file of a real library.
        if (!mayRename(track.path)) {
          throw new AppError('INVALID_INPUT', 'the demo stage renames only generated test files')
        }
        const working = await files.workingPath()
        // It renames and nothing else: the kind of file stays what it is.
        if (extname(fileName).toLowerCase() !== extname(working).toLowerCase()) {
          throw new AppError('INVALID_INPUT', 'the proposed name has another extension')
        }
        const moved = await files.move(join(dirname(working), fileName))
        return moved.collided ? { proposal: { warnings: ['NAME_COLLISION'] } } : undefined
      }
    }
  ]
}
