import * as React from 'react'
import { cn } from '@/lib/cn'

type SelectProps = Omit<React.ComponentProps<'select'>, 'id'> & {
  /** Always visible, above the field. */
  label: string
}

// The native control: keyboard, type-ahead and screen reader behaviour come with it.
export function Select({ className, label, children, ...props }: SelectProps): React.JSX.Element {
  const id = React.useId()

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-text-muted uppercase">
        {label}
      </label>
      <select
        id={id}
        className={cn(
          'h-8 w-full min-w-0 rounded-sm border border-border bg-surface px-3 text-body text-text transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      >
        {children}
      </select>
    </div>
  )
}
