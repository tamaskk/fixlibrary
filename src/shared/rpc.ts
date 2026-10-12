// The main <-> Python sidecar contract: JSON-RPC 2.0, one JSON document per line.
// python/fixlib_py mirrors these methods by hand; change both sides in the same commit.
import { z } from 'zod'
import { CAMELOT_KEYS, KEY_SCALES, keyOf } from './keys'

/** How many files one `tags.read` call may name. The same limit is in fixlib_py/tags.py. */
export const TAG_BATCH_SIZE = 50

// Tag text comes out of a file, so it is untrusted. The sidecar cuts it to one line of
// at most this length without characters that reverse the reading direction; main
// does not take the sidecar's word for it and refuses anything else. The length limit
// also keeps the largest possible answer for one batch below the line limit of the bridge.
const UNSAFE_TAG_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const tagText = z
  .string()
  .min(1)
  .max(300)
  .refine((text) => !UNSAFE_TAG_TEXT.test(text), { message: 'Tag text must be one clean line' })
  .nullable()
const positiveInt = z.number().int().positive().nullable()

export const fileTagsSchema = z.object({
  path: z.string().min(1),
  /** False for a file that is missing, damaged or not one of the app's formats. */
  readable: z.boolean(),
  durationMs: positiveInt,
  bitrateKbps: positiveInt,
  sampleRateHz: positiveInt,
  artist: tagText,
  title: tagText,
  album: tagText,
  label: tagText,
  year: z.number().int().min(1000).max(9999).nullable(),
  hasCover: z.boolean()
})

export type FileTags = z.output<typeof fileTagsSchema>

/**
 * Names the algorithm behind `analysis.bpm_key`. It is stored with every result, and
 * a track is analysed again only when it changes. The same text is ANALYZER_VERSION
 * in fixlib_py/analysis/bpm_key.py.
 */
export const BPM_KEY_ANALYZER_VERSION = 'essentia-2.1b6-multifeature-edma-1'

export const bpmKeyResultSchema = z
  .object({
    /** The tempo inside the range that was asked for, moved there by octaves. */
    bpm: z.number().positive().max(1000),
    /** The tempo as it was measured. */
    rawBpm: z.number().positive().max(10_000),
    /** Essentia's own scale: below 1.5 is a weak guess, above 3.5 a sure one. */
    bpmConfidence: z.number().min(0).max(10),
    keyName: z.string().min(1).max(2),
    scale: z.enum(KEY_SCALES),
    keyStrength: z.number().min(-1).max(1),
    camelot: z.enum(CAMELOT_KEYS),
    musical: z.string().min(1).max(3),
    // A sidecar that runs another algorithm than this build expects is a bug of the
    // build; its results must not be stored under this build's version.
    analyzerVersion: z.literal(BPM_KEY_ANALYZER_VERSION)
  })
  // Both sides hold the table of keys; an answer they disagree on is not taken.
  .refine((result) => {
    const key = keyOf(result.keyName, result.scale)
    return key !== null && key.camelot === result.camelot && key.musical === result.musical
  })

export type BpmKeyResult = z.output<typeof bpmKeyResultSchema>

export const RPC_SCHEMAS = {
  ping: {
    params: z.object({}),
    result: z.object({ version: z.string() })
  },
  echo: {
    params: z.object({ value: z.json() }),
    result: z.object({ value: z.json() })
  },
  shutdown: {
    params: z.object({}),
    result: z.null()
  },
  /** Asks a running job to stop. `cancelled` is false when no such job is running. */
  'job.cancel': {
    params: z.object({ jobId: z.string().min(1).max(64) }),
    result: z.object({ cancelled: z.boolean() })
  },
  'tags.read': {
    params: z.object({ paths: z.array(z.string().min(1)).min(1).max(TAG_BATCH_SIZE) }),
    // One entry per path, in input order. Each entry is checked on its own with
    // `fileTagsSchema` by the caller, so one bad entry cannot reject the others.
    result: z.object({ files: z.array(z.unknown()).max(TAG_BATCH_SIZE) })
  },
  /** Measures tempo and key from the audio of one file. Reads the file only. */
  'analysis.bpm_key': {
    params: z.object({
      path: z.string().min(1),
      jobId: z.string().min(1).max(64),
      bpmMin: z.number(),
      bpmMax: z.number()
    }),
    result: bpmKeyResultSchema
  }
} as const

export type RpcMethods = {
  [M in keyof typeof RPC_SCHEMAS]: {
    params: z.input<(typeof RPC_SCHEMAS)[M]['params']>
    result: z.output<(typeof RPC_SCHEMAS)[M]['result']>
  }
}

export type RpcMethod = keyof RpcMethods

const rpcIdSchema = z.number().int()

const rpcErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  // null when the sidecar could not read the id of a broken request.
  id: rpcIdSchema.nullable(),
  error: z.object({ code: z.number().int(), message: z.string() })
})

const rpcResultResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcIdSchema,
  result: z.unknown()
})

const rpcProgressSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('progress'),
  params: z.object({ jobId: z.string().min(1), percent: z.number().min(0).max(100) })
})

export type RpcProgress = z.output<typeof rpcProgressSchema>['params']

export type RpcMessage =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number | null; code: number; message: string }
  | { kind: 'progress'; progress: RpcProgress }

export function encodeRpcRequest(id: number, method: RpcMethod, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
}

/** Reads one line from the sidecar. Returns null for anything that is not a valid message. */
export function parseRpcLine(line: string): RpcMessage | null {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null

  if ('error' in payload) {
    const parsed = rpcErrorResponseSchema.safeParse(payload)
    if (!parsed.success) return null
    const { id, error } = parsed.data
    return { kind: 'error', id, code: error.code, message: error.message }
  }
  if ('result' in payload) {
    const parsed = rpcResultResponseSchema.safeParse(payload)
    return parsed.success
      ? { kind: 'result', id: parsed.data.id, result: parsed.data.result }
      : null
  }
  const parsed = rpcProgressSchema.safeParse(payload)
  return parsed.success ? { kind: 'progress', progress: parsed.data.params } : null
}
