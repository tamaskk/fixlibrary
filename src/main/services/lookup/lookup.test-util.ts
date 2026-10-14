// Helpers for the tests of the lookup clients. No test here reaches the network.
import type { z } from 'zod'
import type { LookupCache } from './cache'
import { createLookupHttp, LOOKUP_SOURCES, type LookupHttp, type LookupSource } from './http'
import type { RateLimiter } from './rate-limiter'

export const USER_AGENT = 'FixLibrary/0.0.1 (+https://github.com/tamaskk/fixlibrary)'

export interface Recorded {
  url: string
  method: string
  body: string
  headers: Headers
  redirect: RequestInit['redirect']
}

export type Answer = { status?: number; body: unknown; headers?: Record<string, string> } | Error

/** A fetch that gives the next canned answer and records what was asked. */
export function answering(answers: Answer[]): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = []
  const left = [...answers]
  const stub = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      headers: new Headers(init?.headers),
      redirect: init?.redirect
    })
    const answer = left.shift()
    if (answer === undefined) throw new Error('no answer left for this request')
    if (answer instanceof Error) throw answer
    const body =
      typeof answer.body === 'string'
        ? answer.body
        : answer.body instanceof Uint8Array
          ? new Blob([new Uint8Array(answer.body)])
          : JSON.stringify(answer.body)
    return new Response(body, { status: answer.status ?? 200, headers: answer.headers })
  }) as typeof fetch
  return { fetch: stub, requests }
}

/** A limiter that lets everything through at once, and notes the pauses it is asked for. */
export function openLimiter(pauses: number[] = []): RateLimiter {
  return { schedule: (task) => task(), pauseFor: (ms) => void pauses.push(ms) }
}

export function openLimiters(pauses: number[] = []): Record<LookupSource, RateLimiter> {
  return Object.fromEntries(
    LOOKUP_SOURCES.map((source) => [source, openLimiter(pauses)])
  ) as Record<LookupSource, RateLimiter>
}

/** An http layer over canned answers, with no waiting. */
export function httpOver(answers: Answer[]): { http: LookupHttp; requests: Recorded[] } {
  const { fetch, requests } = answering(answers)
  return { http: createLookupHttp({ userAgent: USER_AGENT, fetch }, openLimiters()), requests }
}

/** A cache in memory, as the table would keep it: as JSON, read back through the schema. */
export function memoryCache(): LookupCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    get<T>(source: string, queryKey: string, schema: z.ZodType<T>): T | undefined {
      const kept = entries.get(`${source}\n${queryKey}`)
      if (kept === undefined) return undefined
      const parsed = schema.safeParse(JSON.parse(kept))
      return parsed.success ? parsed.data : undefined
    },
    put(source, queryKey, answer) {
      entries.set(`${source}\n${queryKey}`, JSON.stringify(answer))
    }
  }
}
