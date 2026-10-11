import * as React from 'react'
import { cn } from 'cn'

type InputProps = Omit<React.ComponentProps<'input'>, 'id'> & {
  /** Always visible, above the field. The placeholder is a hint, never the label. */
  label: string
  /**
   * Hides the label visually, for a field in a table whose column header already
   * shows it. The label stays in place for assistive technology.
   */
  labelHidden?: boolean
  error?: string
}

export function Input({
  className,
  label,
  labelHidden = false,
  error,
  ...props
}: InputProps): React.JSX.Element {
  const id = React.useId()
  const errorId = `${id}-error`

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className={cn('text-label text-text-muted uppercase', labelHidden && 'sr-only')}
      >
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'h-8 w-full min-w-0 rounded-sm border border-border bg-surface px-3 text-body text-text transition-colors duration-150 ease-out placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-danger',
          className
        )}
        {...props}
      />
      {error && (
        <p id={errorId} role="alert" className="text-small text-danger-text">
          {error}
        </p>
      )}
    </div>
  )
}
