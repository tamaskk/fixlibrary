// Where the user is in the Rekordbox wizard (T-027), kept in the settings table so a
// wizard left halfway goes on from the same step after a restart. The user does the
// steps in Rekordbox; the app moves on when told, checks what it can (the XML written
// in its step, an export made since the export step), and moves on past the check of
// phase A only when the export is clean.
import { join } from 'path'
import type { AppDatabase } from '../db/connection'
import { getSetting, setSetting } from '../db/settings'
import { xmlModifiedAt } from '../services/rekordbox-xml'
import { logger } from '../services/logger'
import type { Result } from '@shared/errors'
import { REKORDBOX_XML_FILE_NAME } from '@shared/rekordbox'
import {
  INITIAL_WIZARD_STATE,
  PHASE_B_LOCKED,
  PHASE_B_STEPS,
  WIZARD_STEPS,
  wizardActionSchema,
  wizardStateSchema,
  type CopyablePath,
  type WizardCheckResult,
  type WizardState,
  type WizardStep,
  type WizardView
} from '@shared/rekordbox-wizard'
import { EXPORT_TIME_SLACK_MS, judgeExportCheck } from './rekordbox-check'
import { readRekordboxExport, type RekordboxImportDependencies } from './rekordbox-import'
import { readSettings, resolveEffectiveSettings } from './settings'

const WIZARD_KEY = 'rekordboxWizard'

export interface WizardDependencies extends RekordboxImportDependencies {
  db: AppDatabase
}

type StateDependencies = Pick<WizardDependencies, 'db' | 'environment' | 'now'>

export function readWizardState(db: AppDatabase): WizardState {
  // What cannot be read, such as a step a later version renamed, is a wizard that
  // never ran: it shows the setup again, and never keeps the page from loading.
  try {
    return getSetting(db, WIZARD_KEY, wizardStateSchema) ?? INITIAL_WIZARD_STATE
  } catch {
    logger.warn('The state of the Rekordbox wizard could not be read; it starts again')
    return INITIAL_WIZARD_STATE
  }
}

/** Moves the wizard to a step, noting when it got there. */
function enter(
  dependencies: StateDependencies,
  state: WizardState,
  step: WizardState['step'],
  setupDone: boolean = state.setupDone
): WizardState {
  const now = (dependencies.now ?? Date.now)()
  const next: WizardState = {
    setupDone,
    step,
    enteredAt: now,
    exportFrom: step === 'a.export' ? now : state.exportFrom
  }
  setSetting(dependencies.db, WIZARD_KEY, next)
  return next
}

const isPhaseB = (step: WizardStep): boolean =>
  (PHASE_B_STEPS as readonly WizardStep[]).includes(step)

/** The step after one: the setup leads to phase A, phase A's check to its end. */
function stepAfter(step: WizardStep): WizardState['step'] {
  if (step === 'a.check') return PHASE_B_LOCKED ? 'doneA' : 'b.writeXml'
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1] ?? 'doneA'
}

/** The place of a step in the wizard; `doneA` is after every step of phase A. */
const placeOf = (step: WizardState['step']): number =>
  step === 'doneA' ? WIZARD_STEPS.indexOf('a.check') + 1 : WIZARD_STEPS.indexOf(step)

function foldersOf(dependencies: StateDependencies): { xml: string; exportFolder: string } {
  const effective = resolveEffectiveSettings(
    readSettings(dependencies.db),
    dependencies.environment
  )
  return {
    xml: join(effective.generatedXmlFolder, REKORDBOX_XML_FILE_NAME),
    exportFolder: effective.exportedXmlFolder
  }
}

/** True when the XML was written since the XML step was reached. */
async function xmlWrittenSince(dependencies: StateDependencies, since: number): Promise<boolean> {
  const folder = resolveEffectiveSettings(
    readSettings(dependencies.db),
    dependencies.environment
  ).generatedXmlFolder
  const modifiedAt = await xmlModifiedAt(folder)
  return modifiedAt !== null && modifiedAt >= since - EXPORT_TIME_SLACK_MS
}

/**
 * Does what the page asks: a step is done (only the step the wizard is at; the XML
 * must be written since the step was reached; the check is done by checking), back to
 * a step that was done (the setup only while it is not done), or phase A from its
 * start once the setup is done. Phase B is refused while it is locked.
 */
export async function applyWizardAction(
  dependencies: StateDependencies,
  request: unknown
): Promise<Result<WizardState>> {
  const parsed = wizardActionSchema.safeParse(request)
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
  const action = parsed.data
  const state = readWizardState(dependencies.db)

  if (action.type === 'restart') {
    if (!state.setupDone) return { ok: false, code: 'INVALID_INPUT' }
    return { ok: true, value: enter(dependencies, state, 'a.writeXml') }
  }
  if (isPhaseB(action.step) && PHASE_B_LOCKED) return { ok: false, code: 'INVALID_INPUT' }

  if (action.type === 'goTo') {
    // Only back to a step that was reached; the setup, once done, is not shown again.
    const backwards = placeOf(action.step) <= placeOf(state.step)
    const setupAgain = state.setupDone && action.step.startsWith('setup.')
    if (!backwards || setupAgain) return { ok: false, code: 'INVALID_INPUT' }
    return { ok: true, value: enter(dependencies, state, action.step) }
  }

  if (action.step !== state.step || action.step === 'a.check') {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  if (action.step === 'a.writeXml' && !(await xmlWrittenSince(dependencies, state.enteredAt))) {
    return { ok: false, code: 'XML_NOT_FOUND' }
  }
  const setupDone = state.setupDone || action.step === 'setup.importedLibrary'
  return { ok: true, value: enter(dependencies, state, stepAfter(action.step), setupDone) }
}

/**
 * The check of phase A: reads the newest export, keeps its grids, and judges it. A
 * clean one ends phase A; otherwise the wizard stays at the check and says which
 * steps to do again. When the wizard moved while the export was read, nothing is saved.
 */
export async function checkWizardExport(
  dependencies: WizardDependencies
): Promise<Result<WizardCheckResult>> {
  const state = readWizardState(dependencies.db)
  if (state.step !== 'a.check') return { ok: false, code: 'INVALID_INPUT' }
  const read = await readRekordboxExport(dependencies)
  if (!read.ok) return read
  const now = readWizardState(dependencies.db)
  if (now.step !== state.step || now.enteredAt !== state.enteredAt) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  const verdict = judgeExportCheck(read.value, state.exportFrom)
  const next = verdict.clean ? enter(dependencies, state, stepAfter('a.check')) : state
  return { ok: true, value: { check: read.value, verdict, state: next } }
}

/** Where the user is in the wizard, and the paths the steps name. */
export async function readWizardView(dependencies: StateDependencies): Promise<WizardView> {
  const state = readWizardState(dependencies.db)
  const folders = foldersOf(dependencies)
  return {
    state,
    xmlWritten:
      state.step === 'a.writeXml' && (await xmlWrittenSince(dependencies, state.enteredAt)),
    xmlPath: folders.xml,
    exportFolder: folders.exportFolder,
    phaseBLocked: PHASE_B_LOCKED
  }
}

/** The path the wizard copies: the app's XML, or the folder Rekordbox exports to. */
export function pathToCopy(dependencies: StateDependencies, which: CopyablePath): string {
  const folders = foldersOf(dependencies)
  return which === 'xml' ? folders.xml : folders.exportFolder
}
