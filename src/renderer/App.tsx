import { AppSidebar } from '@/components/features/AppSidebar'
import { BatchPreview } from '@/pages/BatchPreview'
import { CueEditor } from '@/pages/CueEditor'
import { Library } from '@/pages/Library'
import { RekordboxWizard } from '@/pages/RekordboxWizard'
import { Settings } from '@/pages/Settings'
import { useAppStore } from '@/stores/app-store'

export function App(): React.JSX.Element {
  const page = useAppStore((state) => state.page)

  return (
    <div className="flex h-full">
      <AppSidebar />
      <div className="min-w-0 flex-1">
        {page === 'settings' ? (
          <Settings />
        ) : page === 'preview' ? (
          <BatchPreview />
        ) : page === 'cues' ? (
          <CueEditor />
        ) : page === 'rekordbox' ? (
          <RekordboxWizard />
        ) : (
          <Library />
        )}
      </div>
    </div>
  )
}
