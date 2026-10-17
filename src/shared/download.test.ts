import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  addressOf,
  failureOf,
  isLowBitrate,
  readInfo,
  readProgressLine,
  readSearchHits,
  searchTermOf
} from './download'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '../../tests/fixtures/yt-dlp', name), 'utf8'))
}

describe('addressOf', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube'],
    ['https://youtu.be/jNQXAC9IVRw', 'youtube'],
    ['https://music.youtube.com/watch?v=jNQXAC9IVRw&list=RD1', 'youtube'],
    ['  https://soundcloud.com/feelmybicep/bicep-glue-clip  ', 'soundcloud'],
    ['https://on.soundcloud.com/abc', 'soundcloud']
  ] as const)('accepts %s as %s', (text, source) => {
    // Act
    const address = addressOf(text)

    // Assert
    expect(address?.source).toBe(source)
  })

  it('makes an http address https', () => {
    // Act
    const address = addressOf('http://www.youtube.com/watch?v=jNQXAC9IVRw')

    // Assert
    expect(address?.url).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  })

  it('drops the fragment of an address', () => {
    // Act
    const address = addressOf('https://youtu.be/x#__youtubedl_smuggle=%7B%7D')

    // Assert
    expect(address?.url).toBe('https://youtu.be/x')
  })

  it.each([
    'https://example.com/watch?v=1',
    'https://youtube.com.evil.example/watch?v=1',
    'file:///etc/passwd',
    'https://user:pw@www.youtube.com/watch?v=1',
    'https://www.youtube.com:8443/watch?v=1',
    '--exec=rm',
    'ytsearch10:bicep',
    '',
    `https://www.youtube.com/watch?v=${'a'.repeat(2000)}`
  ])('refuses %s', (text) => {
    // Act
    const address = addressOf(text)

    // Assert
    expect(address).toBeNull()
  })
})

describe('readInfo', () => {
  const youtube = { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', source: 'youtube' as const }
  const soundcloud = { url: 'https://soundcloud.com/x/y', source: 'soundcloud' as const }

  it('reads a YouTube video with its best audio-only bitrate', () => {
    // Act
    const info = readInfo(fixture('video-youtube.json'), youtube)

    // Assert
    expect(info).toEqual({
      ...youtube,
      title: 'Me at the zoo',
      uploader: 'jawed',
      durationS: 19,
      bitrateKbps: 130
    })
  })

  it('reads a SoundCloud track', () => {
    // Act
    const info = readInfo(fixture('video-soundcloud.json'), soundcloud)

    // Assert
    expect(info).toMatchObject({ title: 'BICEP | GLUE // CLIP', bitrateKbps: 160 })
    expect(info !== null && info !== 'playlist' && isLowBitrate(info)).toBe(false)
  })

  it('reads a source below 128 kbps as low', () => {
    // Act
    const info = readInfo(fixture('low-bitrate.json'), soundcloud)

    // Assert
    expect(info).toMatchObject({ bitrateKbps: 96 })
    expect(info !== null && info !== 'playlist' && isLowBitrate(info)).toBe(true)
  })

  it('says playlist for an answer that names more than one track', () => {
    // Act
    const info = readInfo(fixture('playlist.json'), youtube)

    // Assert
    expect(info).toBe('playlist')
  })

  it('takes a title as one line and an unknown bitrate as not low', () => {
    // Act
    const info = readInfo({ id: 'x', title: 'A\nB‮', formats: [] }, youtube)

    // Assert
    expect(info).toMatchObject({ title: 'A B', bitrateKbps: null, uploader: null })
    expect(info !== null && info !== 'playlist' && isLowBitrate(info)).toBe(false)
  })

  it('gives null for an answer without an id', () => {
    // Act
    const info = readInfo({ title: 'x' }, youtube)

    // Assert
    expect(info).toBeNull()
  })
})

describe('readSearchHits', () => {
  it('reads YouTube hits and leaves out what is not YouTube', () => {
    // Act
    const hits = readSearchHits(fixture('search-youtube.json'), 'youtube')

    // Assert
    expect(hits.map((hit) => hit.title)).toEqual([
      'BICEP | GLUE (Official Video)',
      'Bicep - Glue (Original Mix)',
      'Bicep - Glue & Apricots | Glastonbury 2022'
    ])
    expect(hits[1]).toMatchObject({ uploader: 'Filippos Sgouros', durationS: 270 })
    expect(hits[2]?.durationS).toBeNull()
  })

  it('names a SoundCloud hit by its page, else by its API address', () => {
    // Act
    const hits = readSearchHits(fixture('search-soundcloud.json'), 'soundcloud')

    // Assert
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://soundcloud.com/feelmybicep/bicep-glue-clip',
      'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1041939220'
    ])
  })

  it('gives no hits of another service', () => {
    // Act
    const hits = readSearchHits(fixture('search-soundcloud.json'), 'youtube')

    // Assert
    expect(hits).toEqual([])
  })
})

describe('searchTermOf', () => {
  it('asks for ten hits of the service, as one line', () => {
    // Act
    const youtube = searchTermOf('youtube', 'bicep\nglue')
    const soundcloud = searchTermOf('soundcloud', 'bicep')

    // Assert
    expect(youtube).toBe('ytsearch10:bicep glue')
    expect(soundcloud).toBe('scsearch10:bicep')
  })
})

describe('readProgressLine', () => {
  it.each([
    [
      '[download]  12.6% of  246.27KiB at    5.02MiB/s ETA 00:00',
      { kind: 'download', percent: 12.6 }
    ],
    ['[download] 100% of  246.27KiB in 00:00:00 at 2.23MiB/s', { kind: 'download', percent: 100 }],
    ['[ExtractAudio] Destination: /x/y.mp3', { kind: 'convert' }],
    ['[download] Destination: /x/y.webm', null],
    ['[youtube] jNQXAC9IVRw: Downloading webpage', null],
    ['[download] 900% of x', null]
  ] as const)('reads %s', (line, step) => {
    // Act
    const read = readProgressLine(line)

    // Assert
    expect(read).toEqual(step)
  })
})

describe('failureOf', () => {
  it('suggests an update when yt-dlp could not read the page', () => {
    // Act
    const failure = failureOf([
      'WARNING: something',
      'ERROR: [youtube] abc: Unable to extract initial player response'
    ])

    // Assert
    expect(failure).toBe('extract')
  })

  it('is a plain failure otherwise', () => {
    // Act
    const failure = failureOf(['ERROR: [youtube] abc: Video unavailable'])

    // Assert
    expect(failure).toBe('failed')
  })
})
