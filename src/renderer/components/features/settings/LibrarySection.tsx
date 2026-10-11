import { Switch } from '@/components/ui/switch'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import type { SettingsSnapshot } from '@shared/settings'
import { FolderField } from './FolderField'
import { SettingsSection } from './SettingsSection'
import { StatusLine } from '@/components/ui/status-line'

export function LibrarySection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const update = useSettingsStore((state) => state.update)
  const { feedback, run } = useActionFeedback()
  const { library } = snapshot.settings
  const cleanLibraryMode = library.mode === 'clean_library'

  return (
    <SettingsSection title="Könyvtár" feedback={feedback}>
      <FolderField kind="libraryRoot" label="Könyvtármappa" chosen={library.rootFolder} run={run} />
      <Switch
        label="Clean library mód"
        description="Bekapcsolva az app másolaton dolgozik, az eredeti fájlok nem változnak. Kikapcsolva helyben módosítja a fájlokat, előtte backupot készít."
        checked={cleanLibraryMode}
        onCheckedChange={(enabled) =>
          run(() => update({ library: { mode: enabled ? 'clean_library' : 'in_place' } }))
        }
      />
      <FolderField
        kind="cleanLibrary"
        label="Clean library célmappa"
        chosen={library.cleanLibraryFolder}
        run={run}
      >
        {cleanLibraryMode && library.cleanLibraryFolder === null && (
          <StatusLine tone="warning">
            Clean library módban ki kell választanod a célmappát.
          </StatusLine>
        )}
      </FolderField>
      <FolderField
        kind="backup"
        label="Backup mappa"
        chosen={library.backupFolder}
        fallback={snapshot.effective.backupFolder}
        run={run}
      >
        {/* A library that is a whole drive has no folder next to it for the backups. */}
        {library.rootFolder !== null && snapshot.effective.backupFolder === null && (
          <StatusLine tone="warning">
            Válassz backup mappát: a könyvtár mellett nem hozható létre automatikusan.
          </StatusLine>
        )}
      </FolderField>
    </SettingsSection>
  )
}
