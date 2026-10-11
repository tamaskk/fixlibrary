import * as React from 'react'
import { ApiKeysSection } from '@/components/features/settings/ApiKeysSection'
import { HotCuesSection } from '@/components/features/settings/HotCuesSection'
import { LibrarySection } from '@/components/features/settings/LibrarySection'
import { LoudnessSection } from '@/components/features/settings/LoudnessSection'
import { PerformanceSection } from '@/components/features/settings/PerformanceSection'
import { RekordboxSection } from '@/components/features/settings/RekordboxSection'
import { StylesSection } from '@/components/features/settings/StylesSection'
import { SystemSection } from '@/components/features/settings/SystemSection'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useSettingsStore } from '@/stores/settings-store'

export function Settings(): React.JSX.Element {
  const data = useSettingsStore((state) => state.data)
  const load = useSettingsStore((state) => state.load)

  // Loaded once: the main process is asked again only if the first attempt failed
  // or the user retries. Coming back to the page keeps what is already shown.
  React.useEffect(() => {
    if (useSettingsStore.getState().data.status !== 'ready') void load()
  }, [load])

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-form flex-col gap-6">
        <h1 className="text-h1">Beállítások</h1>
        {data.status === 'loading' && (
          <p role="status" className="text-body text-text-muted">
            Beállítások betöltése…
          </p>
        )}
        {data.status === 'error' && (
          <div role="alert">
            <EmptyState
              message="A beállítások nem tölthetők be."
              action={
                <Button variant="primary" onClick={() => load()}>
                  Próbáld újra
                </Button>
              }
            />
          </div>
        )}
        {data.status === 'ready' && (
          <>
            <LibrarySection snapshot={data.snapshot} />
            <RekordboxSection snapshot={data.snapshot} />
            <ApiKeysSection secretStatus={data.secretStatus} />
            <LoudnessSection snapshot={data.snapshot} />
            <StylesSection styles={data.styles} />
            <HotCuesSection snapshot={data.snapshot} />
            <PerformanceSection snapshot={data.snapshot} />
            <SystemSection />
          </>
        )}
      </div>
    </main>
  )
}
