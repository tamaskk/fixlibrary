import { cn } from '@/lib/cn'
import { AlertTriangle, Check, Minus, X, type LucideIcon } from 'lucide-react'

export type StatusTone = 'success' | 'danger' | 'warning' | 'neutral'

const TONES: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  success: { icon: Check, className: 'text-success' },
  danger: { icon: X, className: 'text-danger-text' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  neutral: { icon: Minus, className: 'text-text-muted' }
}

type StatusLineProps = {
  tone: StatusTone
  children: React.ReactNode
  className?: string
}

// A state is always an icon and words together, never a color on its own.
export function StatusLine({ tone, children, className }: StatusLineProps): React.JSX.Element {
  const { icon: Icon, className: toneClassName } = TONES[tone]

  return (
    <p className={cn('flex items-center gap-1 text-small', toneClassName, className)}>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
