import { Check, Circle, CircleDot, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { WIZARD_PHASES, WIZARD_STEP_TEXTS } from '@/pages/rekordbox-wizard-steps'
import { WIZARD_STEPS, type WizardState, type WizardStep } from '@shared/rekordbox-wizard'

type StepStatus = 'done' | 'current' | 'upcoming' | 'locked'

function statusOf(step: WizardStep, state: WizardState, phaseBLocked: boolean): StepStatus {
  if (step.startsWith('b.') && phaseBLocked) return 'locked'
  if (step.startsWith('setup.') && state.setupDone && state.step !== step) return 'done'
  if (state.step === step) return 'current'
  if (state.step === 'doneA') return step.startsWith('a.') ? 'done' : 'upcoming'
  if (state.step === 'doneB') return 'done'
  return WIZARD_STEPS.indexOf(step) < WIZARD_STEPS.indexOf(state.step) ? 'done' : 'upcoming'
}

const STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  done: 'kész',
  current: 'most',
  upcoming: 'később',
  locked: 'zárolva'
}

type WizardStepListProps = {
  state: WizardState
  phaseBLocked: boolean
  /** Goes back to a step that was done. */
  onGoTo: (step: WizardStep) => void
  disabled: boolean
}

/** The steps of the wizard by phase: what is done, where the user is, what comes. */
export function WizardStepList({
  state,
  phaseBLocked,
  onGoTo,
  disabled
}: WizardStepListProps): React.JSX.Element {
  return (
    <nav aria-label="A varázsló lépései" className="flex w-64 shrink-0 flex-col gap-4">
      {WIZARD_PHASES.filter(
        // The setup is shown until it was done once, and while the user is at it again.
        ({ steps }) =>
          !steps.every((step) => step.startsWith('setup.')) ||
          !state.setupDone ||
          state.step.startsWith('setup.')
      ).map(({ title, steps }) => (
        <div key={title} className="flex flex-col gap-1">
          <h2 className="text-label text-text-muted uppercase">{title}</h2>
          <ol className="flex flex-col">
            {steps.map((step, index) => {
              const status = statusOf(step, state, phaseBLocked)
              const Icon =
                status === 'done'
                  ? Check
                  : status === 'current'
                    ? CircleDot
                    : status === 'locked'
                      ? Lock
                      : Circle
              const content = (
                <>
                  <Icon
                    className={cn('size-4 shrink-0', status === 'done' && 'text-success')}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    {index + 1}. {WIZARD_STEP_TEXTS[step].title}
                  </span>
                  <span className="sr-only">({STATUS_LABELS[status]})</span>
                </>
              )
              const row =
                'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-small'
              return (
                <li key={step} aria-current={status === 'current' ? 'step' : undefined}>
                  {status === 'done' ? (
                    // Only a step that was done is a control: it goes back to that step.
                    <button
                      type="button"
                      disabled={disabled}
                      title="Vissza ehhez a lépéshez"
                      onClick={() => onGoTo(step)}
                      className={cn(
                        row,
                        'text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                        'disabled:pointer-events-none disabled:opacity-50'
                      )}
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      className={cn(
                        row,
                        status === 'current'
                          ? 'bg-surface-hover font-medium text-text'
                          : 'text-text-muted'
                      )}
                    >
                      {content}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      ))}
    </nav>
  )
}
