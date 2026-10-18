import * as React from 'react'
import { DownloadQuestionDialog } from '@/components/features/download/DownloadQuestionDialog'
import { DownloadQueue } from '@/components/features/download/DownloadQueue'
import { DownloadSearch } from '@/components/features/download/DownloadSearch'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusLine } from '@/components/ui/status-line'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/messages'
import { addressesOf, useDownloadStore, type AddressOutcome } from '@/stores/download-store'
import { MAX_PARALLEL_DOWNLOADS } from '@shared/download'

function OutcomeLine({ outcome }: { outcome: AddressOutcome }): React.JSX.Element {
  const name = outcome.title ?? outcome.url
  switch (outcome.state) {
    case 'checking':
      return <StatusLine tone="neutral">Ellenőrzés: {name}</StatusLine>
    case 'started':
      return <StatusLine tone="success">Sorba állítva: {name}</StatusLine>
    case 'declined':
      return <StatusLine tone="neutral">Kihagyva: {name}</StatusLine>
    case 'failed':
      return (
        <StatusLine tone="danger">
          {name}: {errorMessage(outcome.code ?? 'UNEXPECTED')}
        </StatusLine>
      )
  }
}

export function Download(): React.JSX.Element {
  const items = useDownloadStore((state) => state.items)
  const loaded = useDownloadStore((state) => state.loaded)
  const loadFailed = useDownloadStore((state) => state.loadFailed)
  const load = useDownloadStore((state) => state.load)
  const outcomes = useDownloadStore((state) => state.outcomes)
  const working = useDownloadStore((state) => state.working)
  const downloadAll = useDownloadStore((state) => state.downloadAll)
  const [text, setText] = React.useState('')

  React.useEffect(() => {
    void load()
  }, [load])

  const addresses = addressesOf(text)

  function submit(event: React.SubmitEvent): void {
    event.preventDefault()
    void downloadAll(addresses).then(() => setText(''))
  }

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-form flex-col gap-6">
        <h1 className="text-h1">Letöltés</h1>
        <Card>
          <CardTitle>Címek</CardTitle>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Textarea
              label="YouTube- vagy SoundCloud-címek"
              description="Soronként egy track. Playlist, set vagy profil nem tölthető le. A trackek MP3 320-ként az Inbox mappába kerülnek."
              value={text}
              rows={4}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                loading={working}
                disabled={addresses.length === 0}
              >
                Letöltés
              </Button>
            </div>
          </form>
          <div role="status" className="mt-4 flex flex-col gap-1">
            {outcomes.map((outcome) => (
              <OutcomeLine key={outcome.url} outcome={outcome} />
            ))}
          </div>
        </Card>
        <Card>
          <CardTitle>Keresés</CardTitle>
          <DownloadSearch />
        </Card>
        <Card>
          <CardTitle>Letöltések</CardTitle>
          <p className="mb-2 text-small text-text-muted">
            Egyszerre legfeljebb {MAX_PARALLEL_DOWNLOADS} track töltődik. A kész trackek az Inboxból
            maguktól előnézetbe kerülnek.
          </p>
          {!loaded ? (
            <p role="status" className="text-small text-text-muted">
              Betöltés…
            </p>
          ) : loadFailed ? (
            <EmptyState
              message="A letöltések listája nem tölthető be."
              action={<Button onClick={() => void load()}>Próbáld újra</Button>}
            />
          ) : (
            <DownloadQueue items={items} />
          )}
        </Card>
      </div>
      <DownloadQuestionDialog />
    </main>
  )
}
