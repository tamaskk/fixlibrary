/** The Hungarian name of a stage. A stage without one is shown by its own name. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  fingerprint: 'Fingerprint',
  lookup: 'Online lookup',
  bpmKey: 'BPM és key elemzés',
  stems: 'Stem-elemzés',
  energyFeatures: 'Energy jellemzők mérése',
  cues: 'Hot cue-k felismerése',
  loudness: 'Hangerő mérése',
  normalize: 'Hangerő-normalizálás',
  normalizeFile: 'Normalizálás a fájlba',
  naming: 'Fájlnév és névtisztítás',
  rename: 'Átnevezés',
  writeTags: 'Tagek írása',
  convert: 'WAV → AIFF konverzió',
  convertFile: 'WAV fájlok konvertálása',
  duplicates: 'Duplikátumok keresése',
  setAside: 'Duplikátumok félretétele',
  style: 'Stílusbesorolás',
  organize: 'Mappába rendezés',
  organizeFile: 'Áthelyezés a stílusmappába',
  cover: 'Borító keresése',
  embedCover: 'Borító beágyazása',
  demoAnalyze: 'Demo elemzés',
  demoLookup: 'Demo lookup',
  demoRename: 'Demo átnevezés'
}

export function stageLabel(stage: string): string {
  return Object.hasOwn(STAGE_LABELS, stage) ? (STAGE_LABELS[stage] ?? stage) : stage
}
