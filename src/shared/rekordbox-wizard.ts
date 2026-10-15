// The steps of the Rekordbox wizard (T-027) and what the app keeps of where the user
// is in it. The texts of the steps are the page's (`pages/rekordbox-wizard-steps.ts`).
import { z } from 'zod'
import type { RekordboxExportCheck } from './rekordbox'

/** The one-time setup of Rekordbox: shown only until it was done once. */
export const SETUP_STEPS = ['setup.showXml', 'setup.importedLibrary'] as const

/** Phase A: the tracks get into the collection, the missing entries go, the export is checked. */
export const PHASE_A_STEPS = [
  'a.writeXml',
  'a.refresh',
  'a.importTracks',
  'a.importPlaylists',
  'a.waitAnalysis',
  'a.removeMissing',
  'a.reloadTag',
  'a.export',
  'a.check'
] as const

/** Phase B: the hot cues. Locked until the cues exist (T-029). */
export const PHASE_B_STEPS = ['b.writeXml', 'b.import', 'b.export', 'b.check'] as const

export const WIZARD_STEPS = [...SETUP_STEPS, ...PHASE_A_STEPS, ...PHASE_B_STEPS] as const

export type WizardStep = (typeof WIZARD_STEPS)[number]

/** True while phase B cannot be done: no track has hot cues yet. */
export const PHASE_B_LOCKED = true

export const wizardStepSchema = z.enum(WIZARD_STEPS)

/**
 * Where the user is: the step to do, or `doneA` once phase A was checked clean; when
 * the step was reached, and when the user reached the export of phase A. What a step
 * proves (the XML written, the collection exported) must be newer than these.
 */
export const wizardStateSchema = z.object({
  setupDone: z.boolean(),
  step: z.union([wizardStepSchema, z.literal('doneA')]),
  /** When the current step was reached, in ms since the epoch. */
  enteredAt: z.number().default(0),
  /** When the export step of phase A was last reached; an older export is not checked. */
  exportFrom: z.number().nullable().default(null)
})

export type WizardState = z.output<typeof wizardStateSchema>

export const INITIAL_WIZARD_STATE: WizardState = {
  setupDone: false,
  step: 'setup.showXml',
  enteredAt: 0,
  exportFrom: null
}

/** The paths the wizard copies to the clipboard; the main process resolves them. */
export const COPYABLE_PATHS = ['xml', 'exportFolder'] as const

export type CopyablePath = (typeof COPYABLE_PATHS)[number]

/** What the user asks of the wizard. A path or a check is never sent by the page. */
export const wizardActionSchema = z.discriminatedUnion('type', [
  /** The step is done: on to the next. */
  z.object({ type: z.literal('complete'), step: wizardStepSchema }),
  /** Back to a step that was done, to do it again. */
  z.object({ type: z.literal('goTo'), step: wizardStepSchema }),
  /** From the start of phase A, the setup kept. */
  z.object({ type: z.literal('restart') })
])

export type WizardAction = z.input<typeof wizardActionSchema>

/**
 * What keeps a check from being clean besides a step to do again: an export older than
 * the export step (from an earlier run), entries on a drive
 * that is not connected, entries that could not be looked at, entries that were not
 * read. Each hides what the export says of those tracks.
 */
export const CHECK_HOLDS = ['stale', 'unavailable', 'unchecked', 'skipped'] as const

export type CheckHold = (typeof CHECK_HOLDS)[number]

/** The steps of phase A to do again, by what the check found. */
export interface CheckVerdict {
  clean: boolean
  /** In the order of the wizard. */
  repeat: WizardStep[]
  holds: CheckHold[]
}

/** What checking the export did: what it found, the verdict, and where the wizard is now. */
export interface WizardCheckResult {
  check: RekordboxExportCheck
  verdict: CheckVerdict
  state: WizardState
}

/** What the wizard page shows: where the user is, and the folders and file it names. */
export interface WizardView {
  state: WizardState
  /** At the XML step: whether the XML was written since the step was reached. */
  xmlWritten: boolean
  /** The XML the app writes, to give Rekordbox ("Imported Library"). */
  xmlPath: string
  /** Where Rekordbox is to export its collection. */
  exportFolder: string
  phaseBLocked: boolean
}
