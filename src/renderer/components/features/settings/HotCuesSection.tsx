import * as React from 'react'
import { ColorInput } from '@/components/ui/color-input'
import { Input } from '@/components/ui/input'
import { commitOnEnter } from '@/lib/keyboard'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import { HOT_CUE_LETTERS, type SettingsSnapshot } from '@shared/settings'
import { SettingsSection } from './SettingsSection'

type HotCue = SettingsSnapshot['settings']['hotCues'][number]

/** The hot cues as the main process last returned them. */
function storedHotCues(): HotCue[] {
  const { data } = useSettingsStore.getState()
  return data.status === 'ready' ? data.snapshot.settings.hotCues : []
}

export function HotCuesSection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const update = useSettingsStore((state) => state.update)
  const { feedback, run } = useActionFeedback()
  const stored = snapshot.settings.hotCues
  // Names are edited locally and saved when the field loses focus.
  const [names, setNames] = React.useState(() => stored.map((cue) => cue.name))
  // Saves run one after another. Each sends the whole list, so a save that started
  // from an older list would undo the one before it.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())

  function save(index: number, changes: Partial<HotCue>): void {
    queue.current = queue.current.then(async () => {
      await run(() =>
        update({
          hotCues: storedHotCues().map((cue, at) => (at === index ? { ...cue, ...changes } : cue))
        })
      )
      // The field shows what is stored now: the name as the main process normalized it,
      // or, if it was refused, the name from before. Other fields keep what is typed in them.
      const storedName = storedHotCues()[index]?.name
      if (storedName !== undefined) {
        setNames((current) => current.map((name, at) => (at === index ? storedName : name)))
      }
    })
  }

  function saveName(index: number): void {
    const name = (names[index] ?? '').trim()
    if (name === stored[index]?.name) return
    if (name === '') {
      // An empty name is not a change: the stored one comes back.
      setNames(stored.map((cue) => cue.name))
      return
    }
    save(index, { name })
  }

  return (
    <SettingsSection
      title="Hot cue-k"
      description="A nyolc hot cue minden tracken ugyanazt jelenti. A nevüket és a színüket itt állíthatod."
      feedback={feedback}
    >
      <div role="table" aria-label="Hot cue-k" className="flex flex-col gap-2">
        <div role="row" className="flex items-center gap-3 text-label text-text-muted uppercase">
          <span role="columnheader" className="w-8">
            Hely
          </span>
          <span role="columnheader" className="min-w-0 flex-1">
            Név
          </span>
          <span role="columnheader" className="w-32">
            Szín
          </span>
        </div>
        {stored.map((cue, index) => {
          const letter = HOT_CUE_LETTERS[index]
          return (
            <div role="row" key={letter} className="flex items-center gap-3">
              <span role="cell" className="w-8 font-mono text-data text-text-muted">
                {letter}
              </span>
              <div role="cell" className="min-w-0 flex-1">
                <Input
                  label={`${letter} hot cue neve`}
                  labelHidden
                  maxLength={24}
                  value={names[index] ?? ''}
                  onChange={(event) =>
                    setNames(names.map((name, at) => (at === index ? event.target.value : name)))
                  }
                  onBlur={() => saveName(index)}
                  onKeyDown={commitOnEnter}
                />
              </div>
              <div role="cell" className="w-32">
                <ColorInput
                  label={`${letter} hot cue színe`}
                  value={cue.color}
                  onValueChange={(color) => save(index, { color })}
                />
              </div>
            </div>
          )
        })}
      </div>
    </SettingsSection>
  )
}
