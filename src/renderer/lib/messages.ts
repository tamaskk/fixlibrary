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
    case 'RUN_ACTIVE':
      return 'Most nem változtatható: egy futás dolgozik, vagy egy batch jóváhagyásra vár.'
    case 'PREVIEW_CHANGED':
      return 'A duplikátumcsoportok megváltoztak. Semmi nem változott a fájljaidon. Nézd át újra, és hagyd jóvá még egyszer.'
    case 'BACKUPS_IN_USE':
      return 'A backup mappa most nem változhat: az utolsó batch még innen vonható vissza.'
    case 'XML_BUSY':
      return 'Egy XML-művelet már folyamatban van, vagy az imént fejeződött be. Próbáld újra pár másodperc múlva.'
    case 'XML_NOT_FOUND':
      return 'Az export mappájában nincs Rekordbox XML. Exportáld a könyvtárat a Rekordboxból ebbe a mappába.'
    case 'XML_UNREADABLE':
      return 'Ez az XML nem olvasható Rekordbox exportként.'
    case 'COVER_UNUSABLE':
      return 'Ez a kép nem használható borítónak.'
    case 'FILE_UNREADABLE':
      return 'A fájl nem olvasható.'
    case 'LOOKUP_FAILED':
      return 'Az online keresés nem sikerült.'
    case 'CLAUDE_FAILED':
      return 'A Claude nem adott használható választ.'
    case 'WRITE_FAILED':
      return 'A fájl nem írható.'
    case 'OFF_TARGET':
      return 'A normalizálás után mért hangerő eltér a tervezettől. A fájl módosult, a batch visszavonható.'
    case 'NOTHING_TO_UNDO':
      return 'Nincs visszavonható batch.'
    case 'DOWNLOAD_UNSUPPORTED':
      return 'Ez nem egy YouTube- vagy SoundCloud-track címe.'
    case 'DOWNLOAD_PLAYLIST':
      return 'Ez a cím több tracket jelöl (playlist, set vagy profil). Csak egyes trackek tölthetők le.'
    case 'DOWNLOAD_FAILED':
      return 'A letöltés nem sikerült. Ellenőrizd a címet és a hálózatot.'
    case 'DOWNLOAD_EXTRACT_FAILED':
      return 'A yt-dlp nem tudta olvasni a szolgáltatás oldalát. Valószínűleg frissíteni kell a yt-dlp-t.'
    case 'TOOL_MISSING':
      return 'Hiányzik a yt-dlp vagy az ffmpeg ebből a telepítésből.'
    case 'PYTHON_CRASHED':
    case 'PYTHON_ERROR':
    case 'TIMEOUT':
      return 'A hangfeldolgozó nem válaszolt. Próbáld újra.'
    default:
      return 'A művelet nem sikerült. Próbáld újra.'
  }
}
