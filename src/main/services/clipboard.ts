import { clipboard } from 'electron'

/** Puts text on the system clipboard. */
export function copyText(text: string): void {
  clipboard.writeText(text)
}
