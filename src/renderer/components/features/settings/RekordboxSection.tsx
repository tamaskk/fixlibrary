import { useActionFeedback } from '@/lib/use-action-feedback'
import type { SettingsSnapshot } from '@shared/settings'
import { FolderField } from './FolderField'
import { SettingsSection } from './SettingsSection'

export function RekordboxSection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const { feedback, run } = useActionFeedback()
  const { rekordbox } = snapshot.settings

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
      />
      <FolderField
        kind="exportedXml"
        label="A Rekordboxból exportált XML mappája"
        chosen={rekordbox.exportedXmlFolder}
        fallback={snapshot.effective.exportedXmlFolder}
        run={run}
      />
    </SettingsSection>
  )
}
