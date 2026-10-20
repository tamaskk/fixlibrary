import type { FullRunStep, FullRunView } from '@shared/full-run'

/** As often as main looks at the step. */
export const FULL_RUN_TICK_MS_PAGE = 2000

export const STEP_LABELS: Record<FullRunStep, string> = {
  features: 'Energy mérés',
  calibration: 'Kalibráció',
  compute: 'Elemzés',
  preview: 'Előnézet',
  apply: 'Fájlműveletek',
  rekordboxA: 'Rekordbox A',
  cues: 'Hot cue-k',
  rekordboxB: 'Rekordbox B',
  done: 'Kész'
}

/** The steps of this run: the measuring and the calibration only when it does them. */
export function stepsShown(view: Pick<FullRunView, 'calibrates'>): FullRunStep[] {
  const all = Object.keys(STEP_LABELS) as FullRunStep[]
  return view.calibrates ? all : all.filter((step) => step !== 'features' && step !== 'calibration')
}
