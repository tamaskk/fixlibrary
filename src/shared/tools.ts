// The external command-line tools and the result of checking them.
export const TOOL_NAMES = ['yt-dlp', 'ffmpeg', 'fpcalc', 'mp3gain'] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type ToolCheckFailure = 'missing' | 'timeout' | 'failed' | 'unrecognized'

/** Never carries a path or raw tool output, so it is safe to show in the renderer. */
export type ToolCheck =
  | { name: ToolName; ok: true; version: string }
  | { name: ToolName; ok: false; reason: ToolCheckFailure }
