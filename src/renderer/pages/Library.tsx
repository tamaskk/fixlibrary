import * as React from 'react'
import { ScanProgressPanel } from '@/components/features/library/ScanProgressPanel'
import { ScanResult } from '@/components/features/library/ScanResult'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCount } from '@/lib/format'
import { useAppStore } from '@/stores/app-store'
import { useLibraryStore } from '@/stores/library-store'

export function Library(): React.JSX.Element {
  const data = useLibraryStore((state) => state.data)
  const scanning = useLibraryStore((state) => state.scanning)
  const progress = useLibraryStore((state) => state.progress)
  const lastScan = useLibraryStore((state) => state.lastScan)
  const load = useLibraryStore((state) => state.load)
  const scan = useLibraryStore((state) => state.scan)
  const setPage = useAppStore((state) => state.setPage)

  // Asked again on every visit: the library folder may have been chosen in Settings
  // since, and the app may be scanning by itself.
  React.useEffect(() => {
    void load()
  }, [load])

  const ready = data.status === 'ready' ? data : null
  const hasTracks = ready !== null && ready.trackCount > 0

  return (
    <main className="flex h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h1">Könyvtár</h1>
        {hasTracks && (
          <Button variant="secondary" loading={scanning} onClick={() => scan()}>
            Újraolvasás
          </Button>
        )}
      </div>

      {data.status === 'loading' && (
        <p role="status" className="text-body text-text-muted">
          Könyvtár betöltése…
        </p>
      )}
      {data.status === 'error' && (
        <div role="alert" className="flex-1">
          <EmptyState
            className="h-full"
            message="A könyvtár nem tölthető be."
            action={
              <Button variant="primary" onClick={() => load()}>
                Próbáld újra
              </Button>
            }
          />
        </div>
      )}

      {ready !== null && (
        <>
          {scanning && <ScanProgressPanel progress={progress} />}
          {!scanning && <ScanResult outcome={lastScan} />}
          {hasTracks && (
            <p className="text-body text-text-muted">
              <span className="font-mono text-data text-text tabular-nums">
                {formatCount(ready.trackCount)}
              </span>{' '}
              track a könyvtárban.
            </p>
          )}
          {!hasTracks && !scanning && !ready.rootChosen && (
            <EmptyState
              className="flex-1"
              message="Még nincs könyvtár mappa kiválasztva."
              action={
                <Button variant="primary" onClick={() => setPage('settings')}>
                  Beállítások megnyitása
                </Button>
              }
            />
          )}
          {!hasTracks && !scanning && ready.rootChosen && (
            <EmptyState
              className="flex-1"
              message="Még nincs beolvasott track."
              action={
                <Button variant="primary" onClick={() => scan()}>
                  Könyvtár beolvasása
                </Button>
              }
            />
          )}
        </>
      )}
    </main>
  )
}
