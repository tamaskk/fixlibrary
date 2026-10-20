// The state of the packaged Python runtime (T-041), for the page that waits for it.

export interface PythonRuntimeState {
  /** `unpacking` on a first start, or after an update brought a new runtime. */
  status: 'checking' | 'unpacking' | 'ready' | 'failed'
  /** 0 to 1 while unpacking; null when not known. */
  fraction: number | null
}
