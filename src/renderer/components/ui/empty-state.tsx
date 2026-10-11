import * as React from 'react'
import { cn } from '@/lib/cn'

type EmptyStateProps = {
  /** One line saying what belongs here. */
  message: string
  /** The single primary action that fills this view. */
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ message, action, className }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-4 p-12', className)}>
      <p className="text-body text-text-muted">{message}</p>
      {action}
    </div>
  )
}
