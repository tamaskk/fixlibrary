import * as React from 'react'
import { LibraryTable } from '@/components/features/library/LibraryTable'
import { LibraryToolbar } from '@/components/features/library/LibraryToolbar'
import { ScanProgressPanel } from '@/components/features/library/ScanProgressPanel'
import { ScanResult } from '@/components/features/library/ScanResult'
import { SelectionBar } from '@/components/features/library/SelectionBar'
import { RunPanel } from '@/components/features/pipeline/RunPanel'
import { RunResult } from '@/components/features/pipeline/RunResult'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusLine } from '@/components/ui/status-line'
import { applyView, DEFAULT_VIEW } from '@/lib/library-view'
import { scanPhaseLabel } from '@/lib/scan-phase'
import { useAppStore } from '@/stores/app-store'
import { useLibraryStore } from '@/stores/library-store'
import { usePipelineStore } from '@/stores/pipeline-store'

export function Library(): React.JSX.Element {
  const data = useLibraryStore((state) => state.data)
  const scanning = useLibraryStore((state) => state.scanning)
  const progress = useLibraryStore((state) => state.progress)
  const lastScan = useLibraryStore((state) => state.lastScan)
  const list = useLibraryStore((state) => state.list)
  const styles = useLibraryStore((state) => state.styles)
  const view = useLibraryStore((state) => state.view)
  const selection = useLibraryStore((state) => state.selection)
  const requestingRun = useLibraryStore((state) => state.requestingRun)
  const lastRun = useLibraryStore((state) => state.lastRun)
  const load = useLibraryStore((state) => state.load)
  const scan = useLibraryStore((state) => state.scan)
  const loadTracks = useLibraryStore((state) => state.loadTracks)
  const setView = useLibraryStore((state) => state.setView)
  const toggleSort = useLibraryStore((state) => state.toggleSort)
  const select = useLibraryStore((state) => state.select)
  const selectAllShown = useLibraryStore((state) => state.selectAllShown)
  const clearSelection = useLibraryStore((state) => state.clearSelection)
  const run = useLibraryStore((state) => state.run)
  const setPage = useAppStore((state) => state.setPage)
  const functions = usePipelineStore((state) => state.functions)
  const choice = usePipelineStore((state) => state.choice)
  const runProgress = usePipelineStore((state) => state.progress)
  const runFinished = usePipelineStore((state) => state.lastFinished)
  const runProgressAt = usePipelineStore((state) => state.progressAt)
  const runActionFailed = usePipelineStore((state) => state.actionFailed)
  const loadPipeline = usePipelineStore((state) => state.load)
  const choose = usePipelineStore((state) => state.choose)
  const chosenStages = usePipelineStore((state) => state.chosenStages)
  const pauseRun = usePipelineStore((state) => state.pause)
  const resumeRun = usePipelineStore((state) => state.resume)
  const cancelRun = usePipelineStore((state) => state.cancel)

  // Asked again on every visit: the library folder may have been chosen in Settings
  // since, and the app may be scanning by itself.
  React.useEffect(() => {
    void load()
    void loadPipeline()
  }, [load, loadPipeline])

  const tracks = list.status === 'ready' ? list.tracks : null
  const rows = React.useMemo(
    () => (tracks === null ? [] : applyView(tracks, view, styles)),
    [tracks, view, styles]
  )

  const rowIds = React.useMemo(() => rows.map(({ id }) => id), [rows])

  const ready = data.status === 'ready' ? data : null
  // The loaded rows count too: the count in `data` can be older than they are.
  const hasTracks = ready !== null && (ready.trackCount > 0 || (tracks?.length ?? 0) > 0)

  return (
    <main className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
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
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4">
          <StatusLine tone="danger">A könyvtár nem tölthető be.</StatusLine>
          <Button variant="primary" onClick={() => load()}>
            Próbáld újra
          </Button>
        </div>
      )}

      {ready !== null && (
        <>
          {runProgress !== null && (
            <RunPanel
              progress={runProgress}
              receivedAt={runProgressAt}
              actionFailed={runActionFailed}
              onPause={() => void pauseRun()}
              onResume={() => void resumeRun()}
              onCancel={() => void cancelRun()}
            />
          )}
          {scanning && <ScanProgressPanel progress={progress} />}
          <div>
            {/* In the page before a scan starts, so the phase is announced when it changes. */}
            <p role="status" className="sr-only">
              {scanning ? scanPhaseLabel(progress) : ''}
            </p>
            {/* With no folder and no tracks the empty state below says what is wrong. */}
            {/* A run and its result take the place of the note about the last scan. */}
            <ScanResult
              outcome={
                scanning ||
                runProgress !== null ||
                runFinished !== null ||
                (!hasTracks && !ready.rootChosen)
                  ? null
                  : lastScan
              }
            />
            <RunResult finished={runProgress === null ? runFinished : null} />
          </div>

          {hasTracks && (list.status === 'idle' || list.status === 'loading') && (
            <p role="status" className="text-body text-text-muted">
              Trackek betöltése…
            </p>
          )}
          {hasTracks && list.status === 'error' && (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4">
              <StatusLine tone="danger">A trackek listája nem tölthető be.</StatusLine>
              <Button variant="secondary" onClick={() => loadTracks()}>
                Próbáld újra
              </Button>
            </div>
          )}
          {hasTracks && tracks !== null && (
            <>
              <LibraryToolbar
                view={view}
                styles={styles}
                shownCount={rows.length}
                totalCount={tracks.length}
                onChange={setView}
              />
              {rows.length === 0 ? (
                <EmptyState
                  className="flex-1 rounded-lg border border-border"
                  message="Nincs a keresésnek és a szűrőknek megfelelő track."
                  action={
                    <Button variant="secondary" onClick={() => setView(DEFAULT_VIEW)}>
                      Szűrők törlése
                    </Button>
                  }
                />
              ) : (
                <LibraryTable
                  rows={rows}
                  styles={styles}
                  selection={selection}
                  sort={view.sort}
                  onSort={toggleSort}
                  onSelect={(id, modifiers) => select(id, modifiers, rowIds)}
                  onSelectAll={() => selectAllShown(rowIds)}
                  onClearSelection={clearSelection}
                />
              )}
              <SelectionBar
                selectedCount={selection.ids.size}
                functions={functions}
                choice={choice}
                onChoose={choose}
                runActive={runProgress !== null}
                requesting={requestingRun}
                // The note that a run started is only news until the run itself reports.
                outcome={
                  lastRun?.ok && (runProgress !== null || runFinished !== null) ? null : lastRun
                }
                onRun={(scope) => void run(scope, chosenStages())}
              />
            </>
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
