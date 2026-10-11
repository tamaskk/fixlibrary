import type { ScanProgress } from '@shared/library'

/** What a running scan is doing, in words. Null progress is a scan that has just started. */
export function scanPhaseLabel(progress: ScanProgress | null): string {
  return progress?.phase === 'reading' && progress.total > 0 ? 'Tagek olvasása' : 'Fájlok keresése'
}
