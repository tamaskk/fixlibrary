// Generated audio for tests that run the real sidecar. Nothing here is music.
import { writeFileSync } from 'fs'

/** Writes a kick on every beat over an A minor chord, as 16 bit mono WAV. */
export function writeHouseLoop(path: string, bpm: number, seconds: number): void {
  const rate = 44_100
  const beat = 60 / bpm
  const samples = Buffer.alloc(rate * seconds * 2)
  for (let index = 0; index < rate * seconds; index += 1) {
    const time = index / rate
    const sinceBeat = time % beat
    const kick = Math.sin(2 * Math.PI * 55 * sinceBeat) * Math.exp(-sinceBeat * 18)
    const pad =
      [220, 261.63, 329.63].reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * time), 0) / 3
    samples.writeInt16LE(Math.round((0.6 * kick + 0.3 * pad) * 32767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  writeFileSync(path, Buffer.concat([header, samples]))
}
