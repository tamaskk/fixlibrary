import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { formatElapsed } from '@/lib/format'
import { SOURCE_NAMES } from '@/lib/download-labels'
import { errorMessage } from '@/lib/messages'
import { useDownloadStore } from '@/stores/download-store'
import { DOWNLOAD_SOURCES, type DownloadSource } from '@shared/download'

/** A search of YouTube or SoundCloud; a hit goes through the same checks as a pasted address. */
export function DownloadSearch(): React.JSX.Element {
  const search = useDownloadStore((state) => state.search)
  const runSearch = useDownloadStore((state) => state.runSearch)
  const downloadAll = useDownloadStore((state) => state.downloadAll)
  const working = useDownloadStore((state) => state.working)
  const [source, setSource] = React.useState<DownloadSource>('youtube')
  const [query, setQuery] = React.useState('')

  function submit(event: React.SubmitEvent): void {
    event.preventDefault()
    if (query.trim() !== '') void runSearch(source, query)
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="w-40 shrink-0">
          <Select
            label="Forrás"
            value={source}
            onChange={(event) => setSource(event.target.value as DownloadSource)}
          >
            {DOWNLOAD_SOURCES.map((each) => (
              <option key={each} value={each}>
                {SOURCE_NAMES[each]}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <Input
            label="Keresés"
            placeholder="Artist – Title"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button type="submit" loading={search.status === 'loading'} disabled={query.trim() === ''}>
          Keresés
        </Button>
      </form>
      <div role="status">
        {search.status === 'loading' && <StatusLine tone="neutral">Keresés…</StatusLine>}
        {search.status === 'error' && (
          <StatusLine tone="danger">{errorMessage(search.code)}</StatusLine>
        )}
        {search.status === 'ready' && search.hits.length === 0 && (
          <StatusLine tone="neutral">Nincs találat.</StatusLine>
        )}
      </div>
      {search.status === 'ready' && search.hits.length > 0 && (
        <ul aria-label="Találatok" className="flex flex-col">
          {search.hits.map((hit) => (
            <li
              key={hit.url}
              className="flex min-h-9 items-center gap-4 border-b border-border py-1 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body" title={hit.title}>
                  {hit.title}
                </span>
                <span className="truncate text-small text-text-muted">{hit.uploader ?? '–'}</span>
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-data text-text-muted tabular-nums">
                {hit.durationS === null ? '–' : formatElapsed(hit.durationS * 1000)}
              </span>
              <Button
                variant="ghost"
                disabled={working}
                aria-label={`${hit.title} letöltése`}
                onClick={() => void downloadAll([hit.url])}
              >
                Letöltés
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
