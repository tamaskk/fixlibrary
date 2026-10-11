// Single source of truth for the renderer <-> main contract.
// Every channel is listed here; preload and main both derive their types from it.

export const IPC_CHANNELS = {
  appGetVersion: 'app:getVersion'
} as const

export interface FixLibraryApi {
  app: {
    getVersion: () => Promise<string>
  }
}
