import { logger } from './logger'

/** The part of Electron's `powerSaveBlocker` this needs. */
export interface PowerBlocker {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => unknown
}

/**
 * Keeps the Mac from going to sleep while a run works: a sleeping Mac would stop a
 * run that takes hours. The display may still turn off. Returns the function to
 * call when the app starts or stops being busy.
 */
export function createSleepBlocker(blocker: PowerBlocker): (busy: boolean) => void {
  let id: number | null = null
  return (busy) => {
    if (busy && id === null) {
      id = blocker.start('prevent-app-suspension')
      logger.info('Sleep is held off while the run works')
    } else if (!busy && id !== null) {
      blocker.stop(id)
      id = null
      logger.info('Sleep is allowed again')
    }
  }
}
