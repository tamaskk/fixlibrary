import { cn } from 'cn'

type ProgressBarProps = {
  /** 0 to 100. */
  percent: number
  /** Names the work for assistive technology. */
  label: string
  className?: string
}

export function ProgressBar({ percent, label, className }: ProgressBarProps): React.JSX.Element {
  const value = Math.min(100, Math.max(0, Math.round(percent)))

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn('h-1 overflow-hidden rounded-full bg-surface-hover', className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out motion-reduce:transition-none"
        style={{ width: `${value}%` }}
      />
    </div>
  )
}
