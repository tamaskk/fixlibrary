import * as React from 'react'
import { Card } from '@/components/ui/card'
import type { ActionFeedback } from '@/lib/use-action-feedback'
import { StatusLine } from './StatusLine'

type SettingsSectionProps = {
  title: string
  /** At most two lines under the title, when the section needs explaining. */
  description?: string
  /** What became of the last save in this section; shown next to the title. */
  feedback?: ActionFeedback
  children: React.ReactNode
}

export function SettingsSection({
  title,
  description,
  feedback,
  children
}: SettingsSectionProps): React.JSX.Element {
  const headingId = React.useId()

  return (
    <Card role="region" aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-4">
          <h2 id={headingId} className="text-h3">
            {title}
          </h2>
          {/* Always present, so a change is announced; it takes no room in the layout below. */}
          <div role="status" className="min-w-0 text-right">
            {feedback?.kind === 'saved' && <StatusLine tone="success">Elmentve</StatusLine>}
            {feedback?.kind === 'error' && (
              <StatusLine tone="danger">{feedback.message}</StatusLine>
            )}
          </div>
        </div>
        {description && <p className="max-w-prose text-small text-text-muted">{description}</p>}
      </div>
      {children}
    </Card>
  )
}
