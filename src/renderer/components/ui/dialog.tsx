import * as React from 'react'
import { cn } from 'cn'
import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

// Radix closes on Escape and on overlay click by default, as DESIGN_SYSTEM.md §06 requires.
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  title: string
  description?: string
}

export function DialogContent({
  className,
  title,
  description,
  children,
  ...props
}: DialogContentProps): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DialogPrimitive.Content
        // Radix warns when no description exists; opt out explicitly instead of inventing one.
        {...(description ? {} : { 'aria-describedby': undefined })}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-full max-w-modal -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-elevated outline-none',
          className
        )}
        {...props}
      >
        <div className="flex flex-col gap-1 pr-8">
          <DialogPrimitive.Title className="text-h2">{title}</DialogPrimitive.Title>
          {description && (
            <DialogPrimitive.Description className="text-small text-text-muted">
              {description}
            </DialogPrimitive.Description>
          )}
        </div>
        {children}
        <DialogPrimitive.Close
          aria-label="Bezárás"
          className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex justify-end gap-2', className)} {...props} />
}
