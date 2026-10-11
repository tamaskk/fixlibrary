import * as React from 'react'
import { cn } from 'cn'
import { Switch as SwitchPrimitive } from 'radix-ui'

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, 'id' | 'children'> & {
  /** Names the switch. Shown next to it, and clicking it toggles the switch. */
  label: string
  /**
   * Hides the label visually, for a switch in a table whose column header already
   * shows it. The label stays in place for assistive technology.
   */
  labelHidden?: boolean
  /** One line under the label saying what the on state means. */
  description?: string
}

export function Switch({
  className,
  label,
  labelHidden = false,
  description,
  ...props
}: SwitchProps): React.JSX.Element {
  const id = React.useId()
  const labelId = `${id}-label`
  const descriptionId = `${id}-description`

  return (
    // The whole row is the click target: the 16px track alone would be too small to hit.
    <label
      htmlFor={id}
      className={cn(
        'group flex min-h-8 cursor-pointer gap-3 has-disabled:cursor-not-allowed',
        description ? 'items-start' : 'items-center',
        className
      )}
    >
      <SwitchPrimitive.Root
        id={id}
        // Named by the label text alone; the description is read as a description.
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          description && 'mt-1',
          'inline-flex h-4 w-8 shrink-0 items-center rounded-full border border-text-muted bg-surface-hover transition-colors duration-150 ease-out group-hover:border-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:group-hover:border-primary-hover data-[state=checked]:group-hover:bg-primary-hover'
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb className="block size-3 translate-x-0.5 rounded-full bg-text transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
      </SwitchPrimitive.Root>
      <span className={cn('flex flex-col', labelHidden && 'sr-only')}>
        <span id={labelId} className="text-body text-text">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="text-small text-text-muted">
            {description}
          </span>
        )}
      </span>
    </label>
  )
}
