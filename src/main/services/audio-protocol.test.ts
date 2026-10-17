import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioUrlOf, createAudioHandler, openAudioStreamCount } from './audio-protocol'
import { rangeOf, swapSampleBytes } from './audio-stream'

let folder: string
let paths: Map<number, string>

/** An AIFF of 16 bit samples, an ID3 chunk of odd length before the samples. */
function aiffOf(samples: number[], channels = 1): Buffer {
  const rate = 44_100
  const common = Buffer.alloc(18)
  common.writeUInt16BE(channels, 0)
  common.writeUInt32BE(samples.length / channels, 2)
  common.writeUInt16BE(16, 6)
  // The rate as an 80-bit extended number: 2^15 ≤ 44100 < 2^16, so the exponent is 15.
  common.writeUInt16BE(16383 + 15, 8)
  common.writeUInt32BE(rate * 2 ** 16, 10)
  common.writeUInt32BE(0, 14)
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => data.writeInt16BE(value, index * 2))
  const sound = Buffer.concat([Buffer.alloc(8), data])
  const id3 = Buffer.from('ID3abc')
  const chunk = (id: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32BE(body.length, 4)
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([
    Buffer.from('AIFF'),
    chunk('COMM', common),
    chunk('ID3 ', Buffer.concat([id3, Buffer.from('x')])),
    chunk('SSND', sound)
  ])
  const form = Buffer.alloc(8)
  form.write('FORM', 0, 'latin1')
  form.writeUInt32BE(body.length, 4)
  return Buffer.concat([form, body])
}

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer())
}

function request(trackId: number | string, range?: string, method = 'GET'): Request {
  const url = typeof trackId === 'number' ? audioUrlOf(trackId) : trackId
  return new Request(url, { method, headers: range ? { range } : {} })
}

beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-audio-')))
  paths = new Map()
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const handler = (): ReturnType<typeof createAudioHandler> =>
  createAudioHandler({ pathOfTrack: (id) => paths.get(id) ?? null })

describe('the fixlib-audio protocol', () => {
  it('serves an MP3 as it is, and a range of it for seeking', async () => {
    // Arrange
    const path = join(folder, 'a.mp3')
    writeFileSync(path, Buffer.from('0123456789'))
    paths.set(1, path)

    // Act
    const whole = await handler()(request(1))
    const part = await handler()(request(1, 'bytes=2-5'))

    // Assert
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('audio/mpeg')
    expect((await bytesOf(whole)).toString()).toBe('0123456789')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect((await bytesOf(part)).toString()).toBe('2345')
  })

  it('serves an AIFF as a WAV of the same samples, little-endian', async () => {
    // Arrange
    const path = join(folder, 'a.aiff')
    writeFileSync(path, aiffOf([1, -2, 300, 32767]))
    paths.set(1, path)

    // Act
    const whole = await bytesOf(await handler()(request(1)))
    const tail = await handler()(request(1, 'bytes=47-51'))

    // Assert
    expect(whole.subarray(0, 4).toString()).toBe('RIFF')
    expect(whole.subarray(8, 16).toString()).toBe('WAVEfmt ')
    expect(whole.readUInt32LE(24)).toBe(44_100)
    expect(whole.readUInt32LE(40)).toBe(8)
    expect([0, 1, 2, 3].map((index) => whole.readInt16LE(44 + index * 2))).toEqual([
      1, -2, 300, 32767
    ])
    // A range that starts inside a sample gets the right bytes of it.
    expect(tail.headers.get('content-range')).toBe('bytes 47-51/52')
    expect([...(await bytesOf(tail))]).toEqual([...whole.subarray(47, 52)])
  })

  it.each([
    ['an id the database does not know', audioUrlOf(9)],
    ['a path', 'fixlib-audio://track/..%2F..%2Fetc%2Fpasswd'],
    ['another host', 'fixlib-audio://file/1'],
    ['an id that is no number', 'fixlib-audio://track/1a']
  ])('serves nothing for %s', async (_, url) => {
    // Arrange
    const path = join(folder, 'a.mp3')
    writeFileSync(path, 'audio')
    paths.set(1, path)

    // Act
    const response = await handler()(request(url))

    // Assert
    expect(response.status).toBe(404)
  })

  it('does not follow a link in the place of the file', async () => {
    // Arrange
    const secret = join(folder, 'secret.txt')
    writeFileSync(secret, 'secret')
    const path = join(folder, 'a.mp3')
    symlinkSync(secret, path)
    paths.set(1, path)

    // Act
    const response = await handler()(request(1))

    // Assert
    expect(response.status).toBe(404)
  })

  it('does not follow a link in a folder above the file either', async () => {
    // Arrange
    const real = join(folder, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'a.mp3'), 'audio')
    symlinkSync(real, join(folder, 'linked'))
    paths.set(1, join(folder, 'linked', 'a.mp3'))

    // Act
    const response = await handler()(request(1))

    // Assert
    expect(response.status).toBe(404)
  })

  it('refuses a range the file cannot give, and anything but reading', async () => {
    // Arrange
    const path = join(folder, 'a.mp3')
    writeFileSync(path, '0123')
    paths.set(1, path)

    // Act
    const outside = await handler()(request(1, 'bytes=10-20'))
    const written = await handler()(request(1, undefined, 'POST'))

    // Assert
    expect(outside.status).toBe(416)
    expect(outside.headers.get('content-range')).toBe('bytes */4')
    expect(written.status).toBe(405)
  })
})

describe('the files the protocol holds open', () => {
  beforeEach(() => {
    const path = join(folder, 'a.mp3')
    writeFileSync(path, Buffer.alloc(1024 * 1024))
    paths.set(1, path)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets the file go when the player stops reading', async () => {
    // Arrange
    const response = await handler()(request(1))
    const before = openAudioStreamCount()

    // Act
    await response.body?.cancel()

    // Assert
    expect(before).toBe(1)
    expect(openAudioStreamCount()).toBe(0)
  })

  it('ends the oldest of more than eight streams', async () => {
    // Arrange
    const responses: Response[] = []

    // Act
    for (let index = 0; index < 10; index += 1) responses.push(await handler()(request(1)))

    // Assert
    expect(openAudioStreamCount()).toBe(8)
    await Promise.all(responses.map((response) => response.body?.cancel()))
    expect(openAudioStreamCount()).toBe(0)
  })

  it('lets go of a file a paused player has not read for half a minute', async () => {
    // Arrange
    vi.useFakeTimers()
    await handler()(request(1))

    // Act
    vi.advanceTimersByTime(30_000)

    // Assert
    expect(openAudioStreamCount()).toBe(0)
  })

  it('serves nothing in the place of a FIFO, and does not wait for one', async () => {
    // Arrange
    const fifo = join(folder, 'pipe.mp3')
    execFileSync('mkfifo', [fifo])
    paths.set(2, fifo)

    // Act
    const response = await handler()(request(2))

    // Assert
    expect(response.status).toBe(404)
  })
})

describe('rangeOf', () => {
  it.each([
    [null, null],
    ['bytes=0-', { start: 0, end: 99 }],
    ['bytes=10-19', { start: 10, end: 19 }],
    ['bytes=90-500', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=100-', 'invalid'],
    ['bytes=5-2', 'invalid'],
    ['bytes=0-1,4-5', 'invalid'],
    ['items=0-1', 'invalid']
  ] as const)('reads %s of 100 bytes', (header, expected) => {
    // Act
    const range = rangeOf(header, 100)

    // Assert
    expect(range).toEqual(expected)
  })
})

describe('swapSampleBytes', () => {
  it('turns the bytes of each 24 bit sample round', () => {
    // Act
    const swapped = swapSampleBytes(Buffer.from([1, 2, 3, 4, 5, 6]), 24)

    // Assert
    expect([...swapped]).toEqual([3, 2, 1, 6, 5, 4])
  })
})
