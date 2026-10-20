import * as React from 'react'
import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'

/**
 * The news of a new version, once it is downloaded and checked: a line above the page
 * with a way to open the DMG, and then to quit so the new app can be dragged across.
 */
export function UpdateBanner(): React.JSX.Element {
  const view = useUpdateStore((state) => state.view)
  const opened = useUpdateStore((state) => state.opened)
  const openFailed = useUpdateStore((state) => state.openFailed)
  const load = useUpdateStore((state) => state.load)
  const subscribe = useUpdateStore((state) => state.subscribe)
  const open = useUpdateStore((state) => state.open)
  const quit = useUpdateStore((state) => state.quit)

  React.useEffect(() => {
    const unsubscribe = subscribe()
    void load()
    return unsubscribe
  }, [load, subscribe])

  const update = view?.update
  return (
    <div role="status">
      {update?.status === 'ready' && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-6 py-2">
          <span className="flex-1 text-body">
            {opened
              ? 'Zárd be az appot, és húzd az újat az Applications mappába a régi helyére.'
              : openFailed
                ? 'A letöltött frissítés nem nyílt meg. Próbáld újra.'
                : `Új verzió: ${update.version}. Letöltve és ellenőrizve.`}
          </span>
          {opened ? (
            <Button aria-label="Az app bezárása" onClick={() => void quit()}>
              Bezárás
            </Button>
          ) : (
            <Button onClick={() => void open()}>Megnyitás</Button>
          )}
        </div>
      )}
    </div>
  )
}
