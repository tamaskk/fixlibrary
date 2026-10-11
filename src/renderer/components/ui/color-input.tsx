import * as React from 'react'
import { cn } from '@/lib/cn'

type ColorInputProps = Omit<
  React.ComponentProps<'input'>,
  'id' | 'type' | 'value' | 'onChange' | 'onBlur'
> & {
  /** Names the color for assistive technology; the hex value next to it is always visible. */
  label: string
  /** `#rrggbb` */
  value: string
  /** Called once the user has settled on a color, not for every step while choosing. */
  onValueChange: (value: string) => void
}

// The system color picker, with the chosen value spelled out so it is not shown by color alone.
export function ColorInput({
  className,
  label,
  value,
  onValueChange,
  ...props
}: ColorInputProps): React.JSX.Element {
  // The native control only accepts lower-case hex.
  const committed = value.toLowerCase()
  const input = React.useRef<HTMLInputElement>(null)
  // What the picker shows while it differs from the committed value.
  const [choice, setChoice] = React.useState<{ from: string; color: string } | null>(null)
  // A choice made for an older value is void once the value has changed.
  const shown = choice !== null && choice.from === committed ? choice.color : committed

  const latest = React.useRef({ committed, onValueChange })
  React.useEffect(() => {
    latest.current = { committed, onValueChange }
  })

  // React's onChange fires for every step in the picker. The native `change` event
  // fires once, when the picker is closed or left: that is the moment to save.
  React.useEffect(() => {
    const element = input.current
    if (!element) return
    const commit = (): void => {
      if (element.value !== latest.current.committed) latest.current.onValueChange(element.value)
    }
    element.addEventListener('change', commit)
    return () => element.removeEventListener('change', commit)
  }, [])

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <input
        ref={input}
        type="color"
        aria-label={label}
        value={shown}
        onChange={(event) => setChoice({ from: committed, color: event.target.value })}
        className="size-8 shrink-0 cursor-pointer rounded-sm border border-border bg-surface p-1 transition-colors duration-150 ease-out hover:border-text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <span className="font-mono text-data text-text-muted tabular-nums">{shown}</span>
    </div>
  )
}
