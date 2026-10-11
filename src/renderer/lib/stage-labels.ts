/** The Hungarian name of a stage. A stage without one is shown by its own name. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  demoAnalyze: 'Demo elemzés',
  demoLookup: 'Demo lookup',
  demoRename: 'Demo átnevezés'
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}
