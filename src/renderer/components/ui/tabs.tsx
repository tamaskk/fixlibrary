import * as React from 'react'
import { cn } from '@/lib/cn'
import { Tabs as TabsPrimitive } from 'radix-ui'

// Radix moves between the tabs with the arrow keys and shows the panel of the one
// that has the focus, as DESIGN_SYSTEM.md §06 describes.
export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List className={cn('flex gap-4 border-b border-border', className)} {...props} />
  )
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px flex h-8 items-center gap-1 border-b-2 border-transparent px-1 text-small font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary data-[state=active]:border-primary data-[state=active]:text-text',
        className
      )}
      {...props}
    />
  )
}
