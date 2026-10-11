import { StringDecoder } from 'string_decoder'

export interface LineReaderOptions {
  /** Longest line, in characters, that is still delivered. */
  maxLineLength: number
  onLine: (line: string) => void
  /** Called once for a line that grows past the limit; the rest of that line is dropped. */
  onOverflow: () => void
}

/**
 * Splits a byte stream into lines without ever holding more than `maxLineLength`
 * characters, so a process that writes no newline cannot grow our memory.
 */
export function createLineReader(options: LineReaderOptions): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let skipping = false

  return (chunk) => {
    let text = decoder.write(chunk)
    while (text.length > 0) {
      const newlineAt = text.indexOf('\n')
      const piece = newlineAt === -1 ? text : text.slice(0, newlineAt)
      text = newlineAt === -1 ? '' : text.slice(newlineAt + 1)

      if (!skipping) {
        if (buffered.length + piece.length > options.maxLineLength) {
          skipping = true
          buffered = ''
          options.onOverflow()
        } else {
          buffered += piece
        }
      }
      if (newlineAt !== -1) {
        if (!skipping) options.onLine(buffered)
        buffered = ''
        skipping = false
      }
    }
  }
}
