import * as React from 'react'
import { BatchPreviewTable } from '@/components/features/preview/BatchPreviewTable'
import { columnsFor, ERROR_COLUMNS } from '@/components/features/preview/preview-columns'
import { PreviewActions } from '@/components/features/preview/PreviewActions'
import { PreviewNoticeLine } from '@/components/features/preview/PreviewNoticeLine'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCount } from '@/lib/format'
import { FILTER_LABELS } from '@/lib/preview-labels'
import { useAppStore } from '@/stores/app-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { countRows, shownRows, usePreviewStore, type PreviewTab } from '@/stores/preview-store'
import { PREVIEW_FILTERS, type PreviewFilter } from '@shared/preview'

function parseFilter(value: string): PreviewFilter {
  return PREVIEW_FILTERS.find((filter) => filter === value) ?? 'all'
}

export function BatchPreview(): React.JSX.Element {
  const loaded = usePreviewStore((state) => state.loaded)
  const loadFailed = usePreviewStore((state) => state.loadFailed)
  const batch = usePreviewStore((state) => state.batch)
  const canUndo = usePreviewStore((state) => state.canUndo)
  const list = usePreviewStore((state) => state.rows)
  const styles = usePreviewStore((state) => state.styles)
  const tab = usePreviewStore((state) => state.tab)
  const filter = usePreviewStore((state) => state.filter)
  const busy = usePreviewStore((state) => state.busy)
  const notice = usePreviewStore((state) => state.notice)
  const editNote = usePreviewStore((state) => state.editNote)
  const load = usePreviewStore((state) => state.load)
  const setTab = usePreviewStore((state) => state.setTab)
  const setFilter = usePreviewStore((state) => state.setFilter)
  const edit = usePreviewStore((state) => state.edit)
  const refreshing = usePreviewStore((state) => state.refreshing)
  const refreshLookup = usePreviewStore((state) => state.refreshLookup)
  const setExcluded = usePreviewStore((state) => state.setExcluded)
  const approve = usePreviewStore((state) => state.approve)
  const discard = usePreviewStore((state) => state.discard)
  const undo = usePreviewStore((state) => state.undo)
  const setPage = useAppStore((state) => state.setPage)
  const runActive = usePipelineStore((state) => state.progress !== null)
  const loadPipeline = usePipelineStore((state) => state.load)
  const [confirmingUndo, setConfirmingUndo] = React.useState(false)
  // The row the keys of the table act on; "Lookup frissítése" asks about that one.
  const [cursorTrackId, setCursorTrackId] = React.useState<number | null>(null)
  const heading = React.useRef<HTMLHeadingElement>(null)
  const undoButton = React.useRef<HTMLButtonElement>(null)
  const refreshButton = React.useRef<HTMLButtonElement>(null)
  // The button is disabled while it asks, which takes the focus from it: it gets the
  // focus back when the answer is in, unless the user has moved on meanwhile.
  const wasRefreshing = React.useRef(false)
  React.useEffect(() => {
    if (wasRefreshing.current && refreshing === null && document.activeElement === document.body) {
      refreshButton.current?.focus()
    }
    wasRefreshing.current = refreshing !== null
  }, [refreshing])

  // Asked again on every visit: a run may have ended, or a batch been applied, since.
  React.useEffect(() => {
    void load()
    void loadPipeline()
  }, [load, loadPipeline])

  const rows = list.status === 'ready' ? list.rows : null
  const shown = React.useMemo(
    () => (rows === null ? [] : shownRows(rows, tab, filter)),
    [rows, tab, filter]
  )
  const counts = React.useMemo(() => countRows(rows ?? []), [rows])
  /** The button a dialog was opened from, or the top of the page when it is gone or disabled. */
  function focusOrHeading(button: HTMLButtonElement | null): void {
    if (button && !button.disabled) button.focus()
    else heading.current?.focus()
  }

  const columns = batch === null || tab === 'errors' ? ERROR_COLUMNS : columnsFor(batch.type)

  return (
    <main className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          Előnézet
        </h1>
        {canUndo && (
          <Button
            ref={undoButton}
            title={runActive ? 'Futás közben nem vonható vissza.' : undefined}
            variant="secondary"
            disabled={runActive || busy !== null}
            loading={busy === 'undo'}
            onClick={() => setConfirmingUndo(true)}
          >
            Utolsó batch visszavonása
          </Button>
        )}
      </div>

      {/* In the page before there is anything to say, so that it is announced. */}
      {/* It takes no room of its own: only what it holds is a row of the page. */}
      <div role="status" className="contents">
        <PreviewNoticeLine notice={notice} />
        {editNote === 'failed' && (
          <StatusLine tone="danger">
            A változtatás nem sikerült. A sorok újra be lettek töltve.
          </StatusLine>
        )}
        {editNote === 'refused' && <StatusLine tone="danger">Ez az érték nem menthető.</StatusLine>}
        {refreshing !== null && <StatusLine tone="neutral">Online keresés folyamatban…</StatusLine>}
        {editNote === 'lookupDone' && refreshing === null && (
          <StatusLine tone="success">A sor frissítve.</StatusLine>
        )}
        {editNote === 'lookupBusy' && (
          <StatusLine tone="neutral">
            Most nem frissíthető. Próbáld újra pár másodperc múlva.
          </StatusLine>
        )}
        {editNote === 'lookupFailed' && (
          <StatusLine tone="danger">
            Az online keresés nem sikerült. A sor nem változott.
          </StatusLine>
        )}
        {editNote === 'busy' && (
          <StatusLine tone="neutral">Jóváhagyás közben a batch nem változtatható.</StatusLine>
        )}
      </div>

      {!loaded && (
        <p role="status" className="text-body text-text-muted">
          Előnézet betöltése…
        </p>
      )}
      {loaded && loadFailed && (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4">
          <StatusLine tone="danger">Az előnézet nem tölthető be.</StatusLine>
          <Button variant="primary" onClick={() => void load()}>
            Próbáld újra
          </Button>
        </div>
      )}

      {loaded && !loadFailed && batch === null && (
        <EmptyState
          className="flex-1"
          message={
            runActive
              ? 'Egy futás dolgozik. Az állapotát a Könyvtár oldalon látod.'
              : 'Nincs jóváhagyásra váró batch. Indíts egy futást a Könyvtár oldalon.'
          }
          action={
            <Button variant="primary" onClick={() => setPage('library')}>
              Könyvtár megnyitása
            </Button>
          }
        />
      )}

      {loaded && !loadFailed && batch !== null && (
        <>
          {(list.status === 'idle' || list.status === 'loading') && (
            <p role="status" className="text-body text-text-muted">
              Sorok betöltése…
            </p>
          )}
          {list.status === 'error' && (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4">
              <StatusLine tone="danger">A batch sorai nem tölthetők be.</StatusLine>
              <Button variant="secondary" onClick={() => void load()}>
                Próbáld újra
              </Button>
            </div>
          )}
          {rows !== null && (
            <>
              <Tabs
                value={tab}
                onValueChange={(value) => setTab(value as PreviewTab)}
                className="flex min-h-0 flex-1 flex-col gap-4"
              >
                <TabsList aria-label="A batch nézetei">
                  <TabsTrigger value="changes">Változások</TabsTrigger>
                  <TabsTrigger value="errors">
                    Hibák
                    <span className="font-mono text-data tabular-nums">
                      {formatCount(counts.failed)}
                    </span>
                  </TabsTrigger>
                </TabsList>
                {/* One panel for whichever tab is chosen; the table in it is the Tab stop. */}
                <TabsContent
                  value={tab}
                  tabIndex={-1}
                  className="flex min-h-0 flex-1 flex-col gap-4"
                >
                  <div className="flex items-end gap-4">
                    {tab === 'changes' && (
                      <div className="w-64 shrink-0">
                        <Select
                          label="Szűrő"
                          value={filter}
                          onChange={(event) => setFilter(parseFilter(event.target.value))}
                        >
                          {PREVIEW_FILTERS.map((each) => (
                            <option key={each} value={each}>
                              {FILTER_LABELS[each]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {tab === 'changes' && batch.canRefresh && (
                      <>
                        <Button
                          ref={refreshButton}
                          variant="secondary"
                          title="Újra megkérdezi az online forrásokat a választott sorról."
                          disabled={
                            cursorTrackId === null ||
                            runActive ||
                            busy !== null ||
                            refreshing !== null
                          }
                          loading={refreshing !== null}
                          onClick={() => {
                            if (cursorTrackId !== null) void refreshLookup(cursorTrackId)
                          }}
                        >
                          Lookup frissítése
                        </Button>
                        {/* In words next to it: a disabled button shows no tooltip. */}
                        {(runActive || cursorTrackId === null) && (
                          <p className="flex h-8 min-w-0 items-center truncate text-small text-text-muted">
                            {runActive
                              ? 'Futás közben nem frissíthető.'
                              : 'Előbb válassz egy sort, amelyik nem maradt ki.'}
                          </p>
                        )}
                      </>
                    )}
                    <p className="ml-auto flex h-8 shrink-0 items-center gap-1 text-small whitespace-nowrap text-text-muted">
                      <span className="font-mono text-data text-text tabular-nums">
                        {shown.length === rows.length
                          ? formatCount(rows.length)
                          : `${formatCount(shown.length)} / ${formatCount(rows.length)}`}
                      </span>{' '}
                      track
                    </p>
                  </div>

                  {shown.length === 0 ? (
                    <EmptyState
                      className="flex-1 rounded-lg border border-border"
                      message={
                        tab === 'errors'
                          ? 'Egy track sem maradt ki hiba miatt.'
                          : filter === 'all'
                            ? 'Ebben a batch-ben nincs sor.'
                            : 'Nincs a szűrőnek megfelelő sor.'
                      }
                      action={
                        tab === 'changes' && filter !== 'all' ? (
                          <Button variant="secondary" onClick={() => setFilter('all')}>
                            Szűrők törlése
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <BatchPreviewTable
                      label={tab === 'errors' ? 'Kimaradt trackek' : 'Változások'}
                      rows={shown}
                      columns={columns}
                      styles={styles}
                      onEdit={edit}
                      onSetExcluded={(trackId, excluded) => void setExcluded([trackId], excluded)}
                      onCursorRowChange={setCursorTrackId}
                    />
                  )}
                </TabsContent>
              </Tabs>

              <PreviewActions
                mode={batch.mode}
                counts={counts}
                busy={busy}
                onApprove={async () => {
                  // The run panel of the Library page shows the apply phase.
                  if (await approve()) setPage('library')
                }}
                onDiscard={() => void discard()}
                onFocusLost={() => heading.current?.focus()}
              />
            </>
          )}
        </>
      )}

      <Dialog open={confirmingUndo} onOpenChange={setConfirmingUndo}>
        <DialogContent
          // Back to the button, or to the top of the page once there is nothing left
          // to undo and the button is gone.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusOrHeading(undoButton.current)
          }}
          title="Visszavonod az utolsó batch-et?"
          description="A fájlok visszakerülnek abba az állapotba, amiben a batch előtt voltak, és amit a batch létrehozott, törlődik. A jóváhagyásra váró batch elvész."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégsem</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmingUndo(false)
                void undo()
              }}
            >
              Visszavonás
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
