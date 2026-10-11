import * as React from 'react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/messages'
import type { RunAction } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import type { ErrorCode } from '@shared/errors'
import type { FolderKind } from '@shared/settings'

type FolderFieldProps = {
  kind: FolderKind
  label: string
  /** The folder the user chose, or null. */
  chosen: string | null
  /** The folder used while none is chosen, if this folder has a default. */
  fallback?: string | null
  /** Reports the outcome of choosing or removing in the section this field is in. */
  run: RunAction
  children?: React.ReactNode
}

function describeFolderError(code: ErrorCode): string {
  return code === 'INVALID_INPUT'
    ? 'Ez a mappa nem használható. A könyvtár, a clean library és a backup mappa nem lehet egymás almappája.'
    : errorMessage(code)
}

// The folder itself is picked in a dialog of the main process; this only shows the result.
export function FolderField({
  kind,
  label,
  chosen,
  fallback,
  run,
  children
}: FolderFieldProps): React.JSX.Element {
  const pickFolder = useSettingsStore((state) => state.pickFolder)
  const clearFolder = useSettingsStore((state) => state.clearFolder)
  const [focused, setFocused] = React.useState(false)
  const labelId = React.useId()
  const shown = chosen ?? fallback ?? null
  const hasDefault = fallback !== undefined
  const isDefault = chosen === null && shown !== null
  // The last segment is the informative part of a path, so it is the part that never
  // truncates. The slash stays with it, so the boundary survives the truncation.
  const lastSlash = shown === null ? -1 : shown.lastIndexOf('/')
  const parent = shown === null ? '' : shown.slice(0, lastSlash)
  const name = shown === null ? '' : shown.slice(lastSlash)

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-label text-text-muted uppercase">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div
          // A read-only field: focusable and named, so its value can be read like an input's.
          role="textbox"
          aria-readonly="true"
          aria-labelledby={labelId}
          tabIndex={0}
          title={shown ?? undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="flex h-8 min-w-0 flex-1 items-center rounded-sm border border-border bg-bg px-3 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary"
        >
          {shown === null ? (
            <span className="text-text-muted">Nincs kiválasztva</span>
          ) : (
            <>
              <span className="truncate font-mono text-data text-text-muted">{parent}</span>
              <span className="shrink-0 font-mono text-data text-text">{name}</span>
            </>
          )}
          {isDefault && (
            <span className="ml-2 shrink-0 text-small text-text-muted">(alapérték)</span>
          )}
        </div>
        <Button
          aria-label={`${label} kiválasztása`}
          onClick={() => run(() => pickFolder(kind), describeFolderError)}
        >
          Kiválasztás
        </Button>
        {/* Always in the layout, so the path boxes of neighbouring rows stay the same width. */}
        <Button
          variant="ghost"
          className={chosen === null ? 'invisible w-24' : 'w-24'}
          disabled={chosen === null}
          aria-label={hasDefault ? `${label} visszaállítása alapértékre` : `${label} eltávolítása`}
          onClick={() => run(() => clearFolder(kind), describeFolderError)}
        >
          {hasDefault ? 'Alapérték' : 'Eltávolítás'}
        </Button>
      </div>
      {/* The box truncates a long path; while it has the focus the whole path is spelled out. */}
      {focused && shown !== null && (
        <p aria-hidden="true" className="font-mono text-data break-all text-text-muted">
          {shown}
        </p>
      )}
      {children}
    </div>
  )
}
