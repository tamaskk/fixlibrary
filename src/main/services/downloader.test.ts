import { describe, expect, it } from 'vitest'
import { createYtDlp, downloadArgs, infoArgs, searchArgs, YtDlpError } from './downloader'

// A stand-in for yt-dlp: Node running a script that ignores the arguments after it.
function fakeYtDlp(script: string): ReturnType<typeof createYtDlp> {
  return createYtDlp(() => ({ command: process.execPath, args: ['-e', script] }))
}

describe('the arguments', () => {
  it('passes the address after --, never as an option', () => {
    // Act
    const all = [
      infoArgs('-x'),
      searchArgs('ytsearch10:-x'),
      downloadArgs({ url: '-x', inbox: '/i', temp: '/t', thumbnails: '/p', ffmpeg: '/f' })
    ]

    // Assert
    for (const args of all) {
      expect(args.at(-2)).toBe('--')
      expect(args).toContain('--ignore-config')
      expect(args).not.toContain('--exec')
      expect(args).not.toContain('-U')
    }
  })

  it('downloads one track as an MP3 of 320 kbps into the Inbox, the rest elsewhere', () => {
    // Act
    const args = downloadArgs({
      url: 'https://youtu.be/x',
      inbox: '/lib/Inbox',
      temp: '/data/tmp',
      thumbnails: '/data/thumbs',
      ffmpeg: '/bin/ffmpeg'
    })

    // Assert
    expect(args).toEqual(
      expect.arrayContaining(['--no-playlist', 'home:/lib/Inbox', 'temp:/data/tmp', '320K'])
    )
    expect(args).toContain('thumbnail:/data/thumbs')
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/bin/ffmpeg')
  })
})

describe('createYtDlp', () => {
  it('reads the JSON yt-dlp prints', async () => {
    // Arrange
    const ytDlp = fakeYtDlp('process.stdout.write(JSON.stringify({ id: "a" }))')

    // Act
    const answer = await ytDlp.json([], { timeoutMs: 10_000 })

    // Assert
    expect(answer).toEqual({ id: 'a' })
  })

  it('hands every line to the caller', async () => {
    // Arrange
    const ytDlp = fakeYtDlp('console.log("[download]  10.0% of 1MiB"); console.log("done")')
    const lines: string[] = []

    // Act
    await ytDlp.run([], { timeoutMs: 10_000, onLine: (line) => lines.push(line) })

    // Assert
    expect(lines).toEqual(['[download]  10.0% of 1MiB', 'done'])
  })

  it('tells a page it could not read from another failure', async () => {
    // Arrange
    const ytDlp = fakeYtDlp(
      'console.error("ERROR: [youtube] x: Unable to extract initial player response"); process.exit(1)'
    )

    // Act
    const failed = ytDlp.json([], { timeoutMs: 10_000 })

    // Assert
    await expect(failed).rejects.toEqual(new YtDlpError('extract'))
  })

  it('stops a call that takes too long', async () => {
    // Arrange
    const ytDlp = fakeYtDlp('setTimeout(() => {}, 60_000)')

    // Act
    const failed = ytDlp.json([], { timeoutMs: 200 })

    // Assert
    await expect(failed).rejects.toEqual(new YtDlpError('timeout'))
  })

  it('says missing when this installation has no yt-dlp', async () => {
    // Arrange
    const ytDlp = createYtDlp(() => null)

    // Act
    const failed = ytDlp.json([], { timeoutMs: 1000 })

    // Assert
    await expect(failed).rejects.toEqual(new YtDlpError('missing'))
  })

  it('refuses an answer that is no JSON', async () => {
    // Arrange
    const ytDlp = fakeYtDlp('process.stdout.write("not json")')

    // Act
    const failed = ytDlp.json([], { timeoutMs: 10_000 })

    // Assert
    await expect(failed).rejects.toEqual(new YtDlpError('failed'))
  })
})
