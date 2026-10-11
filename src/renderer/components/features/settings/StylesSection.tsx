import * as React from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ColorInput } from '@/components/ui/color-input'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import { NEW_STYLE_COLOR, UNSORTED_STYLE_NAME, type Style, type StyleInput } from '@shared/settings'
import { SettingsSection } from './SettingsSection'
import { StatusLine } from '@/components/ui/status-line'

// A draft row needs a stable key before the database has given it an id.
type DraftStyle = StyleInput & { key: string }

function toDraft(styles: Style[]): DraftStyle[] {
  return styles.map((style) => ({ ...style, key: `stored-${style.id}` }))
}

/** The list as the main process returned it after the save. */
function storedStyles(): Style[] {
  const { data } = useSettingsStore.getState()
  return data.status === 'ready' ? data.styles : []
}

/**
 * What is wrong with the names, in words the user can act on, or null. The main
 * process checks the same rules again; this only gives a more specific message.
 */
function nameProblem(draft: DraftStyle[]): string | null {
  const names = draft.map((style) => style.name.trim().toLowerCase())
  const emptyAt = names.indexOf('')
  if (emptyAt !== -1) return `Egy stílusnak még nincs neve (sor: ${emptyAt + 1}).`
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) return 'Két stílusnak ugyanaz a neve.'
  const badAt = draft.findIndex((style) => /[/\\:]/.test(style.name) || style.name.startsWith('.'))
  if (badAt !== -1) {
    return `A stílus neve mappanév lesz, ezért nem kezdődhet ponttal, és nem lehet benne /, \\ vagy : (sor: ${badAt + 1}).`
  }
  return null
}

export function StylesSection({ styles }: { styles: Style[] }): React.JSX.Element {
  const saveStyles = useSettingsStore((state) => state.saveStyles)
  const dirty = useSettingsStore((state) => state.stylesDirty)
  const setDirty = useSettingsStore((state) => state.setStylesDirty)
  const { feedback, run, fail, clear } = useActionFeedback()
  const [draft, setDraft] = React.useState(() => toDraft(styles))
  const [saving, setSaving] = React.useState(false)
  const nextKey = React.useRef(0)
  // The row whose name field takes the focus once it is on screen.
  const [focusKey, setFocusKey] = React.useState<string | null>(null)

  // Leaving the page drops the draft, so the flag must not outlive it.
  React.useEffect(() => () => setDirty(false), [setDirty])

  function change(next: DraftStyle[]): void {
    setDraft(next)
    setDirty(true)
    clear()
  }

  function edit(key: string, changes: Partial<StyleInput>): void {
    change(draft.map((style) => (style.key === key ? { ...style, ...changes } : style)))
  }

  function move(index: number, offset: -1 | 1): void {
    const next = [...draft]
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(index + offset, 0, moved)
    change(next)
  }

  function add(): void {
    nextKey.current += 1
    const style = { key: `new-${nextKey.current}`, name: '', color: NEW_STYLE_COLOR, isHouse: true }
    // A new style is added above Unsorted; the order can be changed afterwards.
    const unsortedAt = draft.findIndex((existing) => existing.name === UNSORTED_STYLE_NAME)
    const at = unsortedAt === -1 ? draft.length : unsortedAt
    change([...draft.slice(0, at), style, ...draft.slice(at)])
    setFocusKey(style.key)
  }

  async function save(): Promise<void> {
    const problem = nameProblem(draft)
    if (problem !== null) {
      fail(problem)
      return
    }
    setSaving(true)
    const saved = await run(() =>
      saveStyles(draft.map(({ id, name, color, isHouse }) => ({ id, name, color, isHouse })))
    )
    setSaving(false)
    if (saved) {
      setDraft(toDraft(storedStyles()))
      setDirty(false)
    }
  }

  return (
    <SettingsSection
      title="Stílusok"
      description="Minden stílus egy mappa a könyvtárban, ebben a sorrendben. A bizonytalan trackek az Unsorted mappába kerülnek; ezt a stílust nem lehet törölni."
      feedback={feedback}
    >
      <div role="table" aria-label="Stílusok" className="flex flex-col gap-2">
        <div role="row" className="flex items-center gap-3 text-label text-text-muted uppercase">
          <span role="columnheader" className="min-w-0 flex-1">
            Név
          </span>
          <span role="columnheader" className="w-32">
            Szín
          </span>
          <span role="columnheader" className="w-16">
            House
          </span>
          <span role="columnheader" className="w-24">
            Műveletek
          </span>
        </div>
        {draft.map((style, index) => {
          const isUnsorted = style.id !== undefined && style.name === UNSORTED_STYLE_NAME
          const rowName = style.name.trim() === '' ? `${index + 1}. stílus` : style.name
          return (
            <div role="row" key={style.key} className="flex items-center gap-3">
              <div role="cell" className="min-w-0 flex-1">
                <Input
                  label={`${index + 1}. stílus neve`}
                  labelHidden
                  value={style.name}
                  disabled={isUnsorted || saving}
                  maxLength={40}
                  autoFocus={style.key === focusKey}
                  onChange={(event) => edit(style.key, { name: event.target.value })}
                />
              </div>
              <div role="cell" className="w-32">
                <ColorInput
                  label={`${rowName} színe`}
                  disabled={saving}
                  value={style.color}
                  onValueChange={(color) => edit(style.key, { color })}
                />
              </div>
              <div role="cell" className="w-16">
                <Switch
                  label={`${rowName}: a house műfajba tartozik`}
                  labelHidden
                  disabled={saving}
                  checked={style.isHouse}
                  onCheckedChange={(isHouse) => edit(style.key, { isHouse })}
                />
              </div>
              <div role="cell" className="flex w-24 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${rowName} mozgatása feljebb`}
                  disabled={index === 0 || saving}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp strokeWidth={1.75} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${rowName} mozgatása lejjebb`}
                  disabled={index === draft.length - 1 || saving}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown strokeWidth={1.75} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${rowName} törlése`}
                  disabled={isUnsorted || saving}
                  onClick={() => change(draft.filter((existing) => existing.key !== style.key))}
                >
                  <Trash2 strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      <p className="max-w-prose text-small text-text-muted">
        A House jelölés azt mutatja, hogy a stílus a house műfajba tartozik: maga a house vagy
        valamelyik alstílusa, például a tech, latin, afro vagy melodic.
      </p>
      <div className="flex items-center gap-2">
        <Button disabled={saving} onClick={add}>
          <Plus strokeWidth={1.75} aria-hidden="true" />
          Új stílus
        </Button>
        {/* The one change on this page that waits for a button, so it is the primary action. */}
        <Button
          variant={dirty ? 'primary' : 'secondary'}
          loading={saving}
          disabled={!dirty}
          onClick={save}
        >
          Stílusok mentése
        </Button>
        <div role="status">
          {dirty && <StatusLine tone="warning">Nem mentett változások</StatusLine>}
        </div>
      </div>
    </SettingsSection>
  )
}
