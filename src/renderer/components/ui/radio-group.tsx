import * as React from 'react'
import { cn } from '@/lib/cn'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'

type RadioGroupProps = React.ComponentProps<typeof RadioGroupPrimitive.Root> & {
  /** Names the choice for assistive technology: what is chosen, and for which group. */
  'aria-label': string
}

// A row that cannot be chosen does not answer to the pointer.
// Radix moves between the rows with the arrow keys and chooses the row that gets the
// focus, as radio buttons do; the group is one Tab stop.
export function RadioGroup({ className, ...props }: RadioGroupProps): React.JSX.Element {
  return <RadioGroupPrimitive.Root className={cn('flex flex-col', className)} {...props} />
}

type RadioRowProps = React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
  /** Names the row for assistive technology: what choosing it chooses. */
  'aria-label': string
}

/**
 * One choice of a group, as a whole row: the 16px circle comes first, and what the
 * row holds after it. The row is the click target.
 */
export function RadioRow({ className, children, ...props }: RadioRowProps): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'group flex min-h-7 w-full items-center gap-2 text-left transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary enabled:hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-text-muted bg-surface transition-colors duration-150 ease-out group-enabled:group-hover:border-text group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-enabled:group-data-[state=checked]:group-hover:border-primary-hover group-enabled:group-data-[state=checked]:group-hover:bg-primary-hover">
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-white" />
      </span>
      {children}
    </RadioGroupPrimitive.Item>
  )
}
