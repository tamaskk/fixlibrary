import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'
import { Loader2 } from 'lucide-react'

const buttonVariants = cva(
  'text-small focus-visible:outline-primary relative inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 active:brightness-90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary hover:bg-primary-hover text-white',
        secondary: 'border-border bg-surface text-text hover:bg-surface-hover border',
        ghost: 'text-text hover:bg-surface-hover bg-transparent',
        danger: 'bg-danger text-white hover:brightness-110'
      },
      size: {
        default: 'px-3',
        // A square button that holds only an icon; it needs an aria-label.
        icon: 'w-8 px-0'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'default' }
  }
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner in place of the label. The button keeps its width and is not clickable. */
    loading?: boolean
  }

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      data-variant={variant ?? 'secondary'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/* The label stays in the layout while loading so the width does not jump. */}
      <span className={cn('inline-flex items-center gap-2', loading && 'opacity-0')}>
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin" aria-hidden="true" />
        </span>
      )}
    </button>
  )
}
