// The main <-> Python sidecar contract: JSON-RPC 2.0, one JSON document per line.
// python/fixlib_py mirrors these methods by hand; change both sides in the same commit.
import { z } from 'zod'

/** How many files one `tags.read` call may name. The same limit is in fixlib_py/tags.py. */
export const TAG_BATCH_SIZE = 50

// Tag text comes out of a file, so it is untrusted: the sidecar cuts it to one line of
// at most this length, and anything longer is refused here.
const tagText = z.string().min(1).max(500).nullable()
const positiveInt = z.number().int().positive().nullable()

const fileTagsSchema = z.object({
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
  'tags.read': {
    params: z.object({ paths: z.array(z.string().min(1)).min(1).max(TAG_BATCH_SIZE) }),
    // One entry per path, in input order.
    result: z.object({ files: z.array(fileTagsSchema).max(TAG_BATCH_SIZE) })
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
