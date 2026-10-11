import type { ErrorCode } from '@shared/errors'

/** The Hungarian text shown for a failed action. Codes without their own text share one. */
export function errorMessage(code: ErrorCode): string {
  switch (code) {
    case 'STYLE_IN_USE':
      return 'Egy törölt stílus még trackekhez tartozik, ezért a lista nem menthető.'
    case 'SECRET_STORAGE_UNAVAILABLE':
      return 'A Keychain nem érhető el, a kulcs nincs elmentve.'
    case 'INVALID_INPUT':
      return 'Ez az érték nem menthető.'
    case 'LIBRARY_ROOT_UNSUITABLE':
      return 'Ez a mappa nem lehet a könyvtár: túl sok mindent tartalmaz. Válassz egy mappát vagy egy lemezt.'
    case 'LIBRARY_NOT_SET':
      return 'Még nincs könyvtár mappa kiválasztva. A Beállításokban adhatod meg.'
    case 'LIBRARY_UNAVAILABLE':
      return 'A könyvtár mappája nem érhető el. Csatlakoztasd a lemezt, és próbáld újra.'
    case 'PYTHON_CRASHED':
    case 'PYTHON_ERROR':
    case 'TIMEOUT':
      return 'A hangfeldolgozó nem válaszolt. Próbáld újra.'
    default:
      return 'A művelet nem sikerült. Próbáld újra.'
  }
}
