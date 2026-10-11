import * as React from 'react'
import { cn } from '@/lib/cn'

export function Card({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-6', className)} {...props} />
  )
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>): React.JSX.Element {
  return <h3 className={cn('mb-4 text-h3', className)} {...props} />
}
