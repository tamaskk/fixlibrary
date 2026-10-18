// The audio of a track as the renderer plays it (T-030): the file's bytes for an MP3
// or a WAV, and for an AIFF the same samples as a WAV, made on the way. Chromium plays
// no AIFF, and a copy of every AIFF the user listens to would be gigabytes. An AIFF's
// samples are big-endian PCM; a WAV's are the same samples little-endian, so the WAV is
// a header of 44 bytes and the samples with their bytes turned round, byte for byte as
// long as the AIFF's, which keeps every byte range of it a range of the AIFF.
import type { FileHandle } from 'fs/promises'

/** Where the samples of an AIFF are, and what they are. */
export interface AiffLayout {
  channels: number
  sampleRate: number
  bitDepth: 16 | 24
  /** Where the first sample is in the file. */
  dataStart: number
  /** How many bytes of samples. */
  dataLength: number
}

const WAV_HEADER_BYTES = 44
// No AIFF has more chunks before its samples than a tagger writes.
const MAX_CHUNKS = 1000

/** The 80-bit IEEE 754 extended number of an AIFF's sample rate. */
function extendedToNumber(bytes: Buffer): number {
  const exponent = bytes.readUInt16BE(0) & 0x7fff
  const mantissa = bytes.readUInt32BE(2) * 2 ** 32 + bytes.readUInt32BE(6)
  if (exponent === 0 && mantissa === 0) return 0
  return mantissa * 2 ** (exponent - 16383 - 63)
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

/**
 * The samples of an AIFF (or an AIFC of plain big-endian samples), or null for one the
 * app does not play: other than 16 or 24 bit, or samples that are not all in the file.
 */
export async function aiffLayoutOf(file: FileHandle, size: number): Promise<AiffLayout | null> {
  const head = await readAt(file, 0, 12)
  const kind = head.subarray(8, 12).toString('latin1')
  if (head.subarray(0, 4).toString('latin1') !== 'FORM' || (kind !== 'AIFF' && kind !== 'AIFC')) {
    return null
  }
  let common: Buffer | null = null
  let sound: { start: number; length: number } | null = null
  let offset = 12
  for (let count = 0; offset + 8 <= size && count < MAX_CHUNKS; count += 1) {
    const chunk = await readAt(file, offset, 8)
    if (chunk.length < 8) break
    const id = chunk.subarray(0, 4).toString('latin1')
    const length = chunk.readUInt32BE(4)
    if (id === 'COMM') common = await readAt(file, offset + 8, Math.min(length, 64))
    if (id === 'SSND') sound = { start: offset + 8, length }
    if (common && sound) break
    offset += 8 + length + (length & 1)
  }
  if (!common || !sound || common.length < 18) return null
  if (kind === 'AIFC') {
    const compression = common.subarray(18, 22).toString('latin1')
    if (compression !== 'NONE' && compression !== 'twos') return null
  }
  const channels = common.readUInt16BE(0)
  const frames = common.readUInt32BE(2)
  const bitDepth = common.readUInt16BE(6)
  const sampleRate = Math.round(extendedToNumber(common.subarray(8, 18)))
  if (bitDepth !== 16 && bitDepth !== 24) return null
  if (channels < 1 || channels > 8) return null
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192_000) return null
  const dataOffset = (await readAt(file, sound.start, 4)).readUInt32BE(0)
  const dataStart = sound.start + 8 + dataOffset
  const dataLength = channels * frames * (bitDepth / 8)
  if (dataStart + dataLength > Math.min(size, sound.start + sound.length)) return null
  // A WAV counts its size in 32 bits.
  if (dataLength > 0xffffffff - WAV_HEADER_BYTES) return null
  return { channels, sampleRate, bitDepth, dataStart, dataLength }
}

/** The header of a WAV of these samples. */
export function wavHeaderOf(layout: AiffLayout): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  const blockAlign = layout.channels * (layout.bitDepth / 8)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + layout.dataLength, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(layout.channels, 22)
  header.writeUInt32LE(layout.sampleRate, 24)
  header.writeUInt32LE(layout.sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(layout.bitDepth, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(layout.dataLength, 40)
  return header
}

/** The size of the WAV an AIFF is played as. */
export function wavSizeOf(layout: AiffLayout): number {
  return WAV_HEADER_BYTES + layout.dataLength
}

/** Samples with the order of their bytes turned round, in place. */
export function swapSampleBytes(samples: Buffer, bitDepth: 16 | 24): Buffer {
  const width = bitDepth / 8
  for (let at = 0; at + width <= samples.length; at += width) {
    const first = samples[at] as number
    samples[at] = samples[at + width - 1] as number
    samples[at + width - 1] = first
  }
  return samples
}

/**
 * The bytes `start` to `end` (both included) of the WAV an AIFF is played as. The
 * samples are read whole around the range and turned round, so that a range that
 * starts inside a sample still gets its right bytes.
 */
export async function readWavRange(
  file: FileHandle,
  layout: AiffLayout,
  start: number,
  end: number
): Promise<Buffer> {
  const header = wavHeaderOf(layout)
  const parts: Buffer[] = []
  if (start < WAV_HEADER_BYTES) {
    parts.push(header.subarray(start, Math.min(end + 1, WAV_HEADER_BYTES)))
  }
  if (end >= WAV_HEADER_BYTES) {
    const width = layout.bitDepth / 8
    const from = Math.max(start, WAV_HEADER_BYTES) - WAV_HEADER_BYTES
    const to = Math.min(end - WAV_HEADER_BYTES, layout.dataLength - 1)
    const alignedFrom = from - (from % width)
    const alignedTo = to - (to % width) + width - 1
    const samples = await readAt(file, layout.dataStart + alignedFrom, alignedTo - alignedFrom + 1)
    swapSampleBytes(samples, layout.bitDepth)
    parts.push(samples.subarray(from - alignedFrom, to - alignedFrom + 1))
  }
  return Buffer.concat(parts)
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * The one range of a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`) within a file
 * of `size` bytes; null for the whole file. `invalid` for a range the file cannot give.
 */
export function rangeOf(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return 'invalid'
  const [, first = '', last = ''] = match
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}
