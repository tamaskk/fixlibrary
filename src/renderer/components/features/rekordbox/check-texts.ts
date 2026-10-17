import { formatCount } from '@/lib/format'
import type { CheckHold } from '@shared/rekordbox-wizard'

/** What kept a check of the wizard from passing besides a step to do again. */
export const HOLD_TEXTS: Readonly<Record<CheckHold, (count: number) => string>> = {
  stale: () =>
    'Ez az export régebbi, mint az export lépése. Exportáld újra a collectiont, és ellenőrizd újra.',
  unavailable: (count) =>
    `${formatCount(count)} bejegyzés nem csatlakoztatott lemezen van, ezek nincsenek ellenőrizve. Csatlakoztasd a lemezt, és ellenőrizd újra.`,
  unchecked: (count) =>
    `${formatCount(count)} bejegyzést nem lehetett ellenőrizni (hálózati mappa vagy olvasási hiba).`,
  skipped: (count) => `${formatCount(count)} bejegyzés nem olvasható.`
}
