/** The Hungarian name of a stage. A stage without one is shown by its own name. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  bpmKey: 'BPM és key elemzés',
  demoAnalyze: 'Demo elemzés',
  demoLookup: 'Demo lookup',
  demoRename: 'Demo átnevezés'
}

export function stageLabel(stage: string): string {
  return Object.hasOwn(STAGE_LABELS, stage) ? (STAGE_LABELS[stage] ?? stage) : stage
}
