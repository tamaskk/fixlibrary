import { basename, dirname, extname, join } from 'path'
import type { Track } from '../../db/tracks'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import type { Stage } from './stage'

const DEFAULT_DEMO_STAGE_MS = 200

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
  return `${name}${mix === '' ? '' : ` (${mix})`}`.normalize('NFC').slice(0, 200).trim() + extension
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
 * real stage. They are only ever added in development (see `src/main/index.ts`).
 */
export function createDemoStages(ms: number = DEFAULT_DEMO_STAGE_MS): Stage[] {
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
      run: async ({ files, proposal }) => {
        if (!files) throw new Error('an apply stage must be given its files')
        const fileName = proposal.fields?.fileName?.value
        if (typeof fileName !== 'string') return
        const working = await files.workingPath()
        const moved = await files.move(join(dirname(working), fileName))
        return moved.collided ? { proposal: { warnings: ['NAME_COLLISION'] } } : undefined
      }
    }
  ]
}
