import type { FixLibraryApi } from '@shared/ipc'

declare global {
  interface Window {
    api: FixLibraryApi
  }
}
