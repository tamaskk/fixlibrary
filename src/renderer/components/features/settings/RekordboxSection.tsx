import * as React from 'react'
import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useActionFeedback } from '@/lib/use-action-feedback'
import type { ErrorCode, Result } from '@shared/errors'
import type { RekordboxXmlWritten, XmlFolderWarning } from '@shared/rekordbox'
import type { SettingsSnapshot } from '@shared/settings'
import { FolderField } from './FolderField'
import { SettingsSection } from './SettingsSection'

const FOLDER_WARNINGS: Readonly<Record<Exclude<XmlFolderWarning, null>, string>> = {
  external:
    'Ez a mappa külső lemezen van. Ha a lemez nincs csatlakoztatva, a Rekordbox nem találja az XML-t. Válassz mappát a Mac belső lemezén.',
  cloud:
    'Ezt a mappát egy felhőszolgáltatás szinkronizálja, ami importhibát okozhat. Válassz nem szinkronizált mappát.'
}

function describeWriteError(code: ErrorCode): string {
  switch (code) {
    case 'RUN_ACTIVE':
      return 'Most nem írható: egy batch fájlokat változtat, vagy a könyvtár beolvasása tart.'
    case 'WRITE_FAILED':
      return 'Az XML nem írható ebbe a mappába. Nézd meg, hogy a mappa elérhető-e.'
    default:
      return errorMessage(code)
  }
}

export function RekordboxSection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const { feedback, run } = useActionFeedback()
  const { rekordbox } = snapshot.settings
  const warning = snapshot.effective.generatedXmlWarning
  const [writing, setWriting] = React.useState(false)
  const [written, setWritten] = React.useState<Result<RekordboxXmlWritten> | null>(null)
  // What was said about the last write is about the folder it was written to.
  const [shownFor, setShownFor] = React.useState(snapshot.effective.generatedXmlFolder)
  if (shownFor !== snapshot.effective.generatedXmlFolder) {
    setShownFor(snapshot.effective.generatedXmlFolder)
    setWritten(null)
  }

  async function writeXml(): Promise<void> {
    setWriting(true)
    setWritten(null)
    try {
      setWritten(await window.api.rekordbox.writeXml())
    } catch {
      setWritten({ ok: false, code: 'UNEXPECTED' })
    } finally {
      setWriting(false)
    }
  }

  return (
    <SettingsSection
      title="Rekordbox"
      description="Az app XML-fájlt ír a Rekordboxnak, és beolvassa a Rekordboxból exportált XML-t."
      feedback={feedback}
    >
      <FolderField
        kind="generatedXml"
        label="Az app által írt XML mappája"
        chosen={rekordbox.generatedXmlFolder}
        fallback={snapshot.effective.generatedXmlFolder}
        run={run}
      >
        {warning !== null && <StatusLine tone="warning">{FOLDER_WARNINGS[warning]}</StatusLine>}
      </FolderField>
      <FolderField
        kind="exportedXml"
        label="A Rekordboxból exportált XML mappája"
        chosen={rekordbox.exportedXmlFolder}
        fallback={snapshot.effective.exportedXmlFolder}
        run={run}
      />
      <div className="flex flex-col gap-2">
        <div>
          <Button loading={writing} onClick={() => void writeXml()}>
            XML írása
          </Button>
        </div>
        <p className="text-small text-text-muted">
          A könyvtár minden trackje bekerül, stílusonként egy playlisttel. A duplikátumként
          félretett, a nem csatlakoztatott lemezen lévő és a hiányzó fájlok kimaradnak.
        </p>
        <div role="status">
          {written?.ok === true && (
            <>
              <StatusLine tone="success">
                {`Az XML elkészült: ${formatCount(written.value.tracks)} track${
                  written.value.skipped > 0
                    ? `, ${formatCount(written.value.skipped)} kimaradt`
                    : ''
                }.`}
              </StatusLine>
              {/* Spelled out whole: this is the file to choose in Rekordbox. */}
              <p className="font-mono text-data break-all text-text-muted">{written.value.path}</p>
            </>
          )}
          {written?.ok === false && (
            <StatusLine tone="danger">{describeWriteError(written.code)}</StatusLine>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
