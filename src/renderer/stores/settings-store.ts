import { create } from 'zustand'
import type { ErrorCode, Result } from '@shared/errors'
import type {
  FolderKind,
  SecretName,
  SecretStatus,
  SettingsPatch,
  SettingsSnapshot,
  Style,
  StyleInput
} from '@shared/settings'

interface LoadedSettings {
  snapshot: SettingsSnapshot
  styles: Style[]
  secretStatus: SecretStatus
}

type SettingsData =
  { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & LoadedSettings)

interface SettingsState {
  data: SettingsData
  load: () => Promise<void>
  /** Each action resolves to null on success, or to the code of what went wrong. */
  update: (patch: SettingsPatch) => Promise<ErrorCode | null>
  pickFolder: (kind: FolderKind) => Promise<ErrorCode | null>
  clearFolder: (kind: FolderKind) => Promise<ErrorCode | null>
  saveStyles: (styles: StyleInput[]) => Promise<ErrorCode | null>
  saveSecret: (name: SecretName, value: string) => Promise<ErrorCode | null>
  clearSecret: (name: SecretName) => Promise<ErrorCode | null>
  /** Goes up whenever a key is saved or deleted; a key test result is only valid for one value. */
  secretRevision: number
  /** True while the styles section holds edits that are not saved yet. */
  stylesDirty: boolean
  setStylesDirty: (dirty: boolean) => void
}

// The main process is the authority: the store only ever holds what main returned.
export const useSettingsStore = create<SettingsState>((set, get) => {
  function patchLoaded(changes: Partial<LoadedSettings>): void {
    const { data } = get()
    if (data.status === 'ready') set({ data: { ...data, ...changes } })
  }

  function applySnapshot(result: Result<SettingsSnapshot> | null): ErrorCode | null {
    if (result === null) return null
    if (!result.ok) return result.code
    patchLoaded({ snapshot: result.value })
    return null
  }

  return {
    data: { status: 'loading' },

    async load() {
      set({ data: { status: 'loading' } })
      try {
        const [snapshot, styles, secretStatus] = await Promise.all([
          window.api.settings.get(),
          window.api.styles.list(),
          window.api.secrets.status()
        ])
        set({ data: { status: 'ready', snapshot, styles, secretStatus } })
      } catch {
        set({ data: { status: 'error' } })
      }
    },

    update: async (patch) => applySnapshot(await window.api.settings.update(patch)),
    pickFolder: async (kind) => applySnapshot(await window.api.settings.pickFolder(kind)),
    clearFolder: async (kind) => applySnapshot(await window.api.settings.clearFolder(kind)),

    async saveStyles(styles) {
      const result = await window.api.styles.save(styles)
      if (!result.ok) return result.code
      patchLoaded({ styles: result.value })
      return null
    },

    async saveSecret(name, value) {
      const result = await window.api.secrets.save({ name, value })
      if (!result.ok) return result.code
      patchLoaded({ secretStatus: result.value })
      set({ secretRevision: get().secretRevision + 1 })
      return null
    },

    async clearSecret(name) {
      patchLoaded({ secretStatus: await window.api.secrets.clear(name) })
      set({ secretRevision: get().secretRevision + 1 })
      return null
    },

    secretRevision: 0,

    stylesDirty: false,
    setStylesDirty: (stylesDirty) => set({ stylesDirty })
  }
})
