import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

export function Library(): React.JSX.Element {
  return (
    <main className="flex h-full flex-col p-6">
      <h1 className="text-h1">Könyvtár</h1>
      <EmptyState
        className="flex-1"
        message="Még nincs beolvasott track."
        // Scanning arrives with T-008; until then the action is visible but inactive.
        action={
          <Button variant="primary" disabled>
            Könyvtár beolvasása
          </Button>
        }
      />
    </main>
  )
}
