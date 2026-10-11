import * as React from 'react'
import { cn } from '@/lib/cn'
import { Check } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'

type CheckboxProps = Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, 'children'> & {
  /** Names the box for assistive technology: what it switches, and for which row. */
  'aria-label': string
}

// The box is 16px; the button around it is 28px, the smallest click target of §08.
export function Checkbox({ className, ...props }: CheckboxProps): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'group flex size-7 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <span className="flex size-4 items-center justify-center rounded-sm border border-text-muted bg-surface transition-colors duration-150 ease-out group-hover:border-text group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:group-hover:border-primary-hover group-data-[state=checked]:group-hover:bg-primary-hover">
        <CheckboxPrimitive.Indicator>
          <Check className="size-3 text-white" strokeWidth={3} aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  )
}
