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
    default:
      return 'A művelet nem sikerült. Próbáld újra.'
  }
}
