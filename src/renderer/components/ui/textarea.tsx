import * as React from 'react'
import { cn } from '@/lib/cn'

type TextareaProps = Omit<React.ComponentProps<'textarea'>, 'id'> & {
  /** Always visible, above the field. The placeholder is a hint, never the label. */
  label: string
  /** A caption under the field, in Small text-muted. */
  description?: string
}

// An input of several lines: the same border, background and focus ring as `Input`.
export function Textarea({
  className,
  label,
  description,
  ...props
}: TextareaProps): React.JSX.Element {
  const id = React.useId()
  const descriptionId = `${id}-description`

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-text-muted uppercase">
        {label}
      </label>
      <textarea
        id={id}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'min-h-24 w-full min-w-0 resize-y rounded-sm border border-border bg-surface px-3 py-2 font-mono text-data text-text transition-colors duration-150 ease-out placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
      {description && (
        <p id={descriptionId} className="text-small text-text-muted">
          {description}
        </p>
      )}
    </div>
  )
}
