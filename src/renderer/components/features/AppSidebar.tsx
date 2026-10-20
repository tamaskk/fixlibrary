import * as React from 'react'
import { cn } from '@/lib/cn'
import {
  AudioWaveform,
  Disc3,
  Download,
  Gauge,
  Library,
  ListChecks,
  ListMusic,
  Settings,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { useAppStore, type AppPage } from '@/stores/app-store'
import { useSettingsStore } from '@/stores/settings-store'

const PAGES: { page: AppPage; label: string; icon: LucideIcon }[] = [
  { page: 'library', label: 'Könyvtár', icon: Library },
  { page: 'preview', label: 'Előnézet', icon: ListChecks },
  { page: 'download', label: 'Letöltés', icon: Download },
  { page: 'cues', label: 'Cue-k', icon: AudioWaveform },
  { page: 'energy', label: 'Energy', icon: Gauge },
  { page: 'playlists', label: 'Playlistek', icon: ListMusic },
  { page: 'generator', label: 'Generátor', icon: Sparkles },
  { page: 'rekordbox', label: 'Rekordbox', icon: Disc3 },
  { page: 'settings', label: 'Beállítások', icon: Settings }
]

export function AppSidebar(): React.JSX.Element {
  const currentPage = useAppStore((state) => state.page)
  const setPage = useAppStore((state) => state.setPage)
  const stylesDirty = useSettingsStore((state) => state.stylesDirty)
  const setStylesDirty = useSettingsStore((state) => state.setStylesDirty)
  // The page the user asked for while the settings page still holds unsaved edits.
  const [pendingPage, setPendingPage] = React.useState<AppPage | null>(null)

  function open(page: AppPage): void {
    if (page === currentPage) return
    if (currentPage === 'settings' && stylesDirty) setPendingPage(page)
    else setPage(page)
  }

  function discardAndLeave(): void {
    if (pendingPage === null) return
    setStylesDirty(false)
    setPage(pendingPage)
    setPendingPage(null)
  }

  return (
    <nav
      aria-label="Oldalak"
      className="flex w-sidebar shrink-0 flex-col gap-1 border-r border-border bg-surface p-2"
    >
      {PAGES.map(({ page, label, icon: Icon }) => {
        const isCurrent = page === currentPage
        return (
          <button
            key={page}
            type="button"
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => open(page)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-r-md border-l-2 border-transparent px-3 text-small font-medium text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              isCurrent && 'border-primary bg-surface-hover text-text'
            )}
          >
            <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {label}
          </button>
        )
      })}
      <Dialog
        open={pendingPage !== null}
        onOpenChange={(isOpen) => !isOpen && setPendingPage(null)}
      >
        <DialogContent
          title="Nem mentett stílusok"
          description="A stílusok listáján vannak nem mentett változások. Ha most elhagyod az oldalt, elvesznek."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Maradok</Button>
            </DialogClose>
            <Button variant="danger" onClick={discardAndLeave}>
              Változások elvetése
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  )
}
