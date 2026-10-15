import * as React from 'react'
import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatDateTime } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useActionFeedback } from '@/lib/use-action-feedback'
import type { ErrorCode, Result } from '@shared/errors'
import type { RekordboxExportCheck, RekordboxXmlWritten, XmlFolderWarning } from '@shared/rekordbox'
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

function describeReadError(code: ErrorCode): string {
  return code === 'RUN_ACTIVE'
    ? 'Most nem olvasható be: egy batch fájlokat változtat, vagy a könyvtár beolvasása tart.'
    : errorMessage(code)
}

/** What a read of the export found, line by line: what the wizard is to put right. */
function CheckLines({ check }: { check: RekordboxExportCheck }): React.JSX.Element {
  const problems = [
    check.notInExport.count > 0 &&
      `${formatCount(check.notInExport.count)} track a könyvtárból hiányzik az exportból.`,
    check.missingFiles.count > 0 &&
      `${formatCount(check.missingFiles.count)} bejegyzés nem létező fájlra mutat (missing).`,
    check.unanalysed.count > 0 &&
      `${formatCount(check.unanalysed.count)} track nincs elemezve a Rekordboxban.`,
    check.skipped > 0 && `${formatCount(check.skipped)} bejegyzés nem olvasható.`
  ].filter((line): line is string => typeof line === 'string')
  // Not problems of the library: what could not be looked at is said, not counted against it.
  const notes = [
    check.unavailable > 0 &&
      `${formatCount(check.unavailable)} bejegyzés nem csatlakoztatott lemezen van, ezek nincsenek ellenőrizve.`,
    check.unchecked > 0 &&
      `${formatCount(check.unchecked)} bejegyzést nem lehetett ellenőrizni (hálózati mappa vagy olvasási hiba).`
  ].filter((line): line is string => typeof line === 'string')
  return (
    <>
      <StatusLine tone={problems.length === 0 ? 'success' : 'neutral'} className="break-all">
        {`Beolvasva: ${check.fileName} (${formatDateTime(check.exportedAt)}), ${formatCount(
          check.tracks
        )} track, ebből ${formatCount(check.matched)} a könyvtárból.`}
      </StatusLine>
      {problems.length === 0 ? (
        <StatusLine tone="success">
          Minden track benne van, nincs missing bejegyzés, és mind elemezve van.
        </StatusLine>
      ) : (
        problems.map((line) => (
          <StatusLine key={line} tone="warning">
            {line}
          </StatusLine>
        ))
      )}
      {notes.map((line) => (
        <StatusLine key={line} tone="neutral">
          {line}
        </StatusLine>
      ))}
    </>
  )
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

  const [reading, setReading] = React.useState(false)
  const [checked, setChecked] = React.useState<Result<RekordboxExportCheck> | null>(null)
  const [checkedFor, setCheckedFor] = React.useState(snapshot.effective.exportedXmlFolder)
  if (checkedFor !== snapshot.effective.exportedXmlFolder) {
    setCheckedFor(snapshot.effective.exportedXmlFolder)
    setChecked(null)
  }

  async function readExport(): Promise<void> {
    setReading(true)
    setChecked(null)
    try {
      setChecked(await window.api.rekordbox.readExport())
    } catch {
      setChecked({ ok: false, code: 'UNEXPECTED' })
    } finally {
      setReading(false)
    }
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
      <FolderField
        kind="exportedXml"
        label="A Rekordboxból exportált XML mappája"
        chosen={rekordbox.exportedXmlFolder}
        fallback={snapshot.effective.exportedXmlFolder}
        run={run}
      />
      <div className="flex flex-col gap-2">
        <div>
          <Button loading={reading} onClick={() => void readExport()}>
            Export beolvasása
          </Button>
        </div>
        <p className="text-small text-text-muted">
          A mappa legújabb XML-jét olvassa be, a fixlibrary.xml kivételével. A trackek a Rekordbox
          beatgridjét kapják meg a hot cue-khoz.
        </p>
        <div role="status">
          {checked?.ok === true && <CheckLines check={checked.value} />}
          {checked?.ok === false && (
            <StatusLine tone="danger">{describeReadError(checked.code)}</StatusLine>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
