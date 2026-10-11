import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>

const listeners = new Map<string, Listener>()

// Stands in for Electron: keeps the registered listener so a test can call it as IPC would.
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: Listener) => listeners.set(channel, listener) }
}))

const { handleIpc, isRendererUrl, setRendererEntry } = await import('./handle')

const APP_PAGE =
  'file:///Applications/FixLibrary.app/Contents/Resources/app.asar/out/renderer/index.html'

/** An IPC event as Electron would deliver it for a call from `frameUrl`. */
function eventFrom(
  frameUrl: string,
  options: { subFrame?: boolean; frameGone?: boolean } = {}
): unknown {
  const mainFrame = { url: frameUrl }
  const senderFrame = options.frameGone ? null : options.subFrame ? { url: frameUrl } : mainFrame
  return { senderFrame, sender: { mainFrame } }
}

describe('handleIpc', () => {
  const handler = vi.fn((_event: unknown, name: string) => `hello ${name}`)

  function call(event: unknown, ...args: unknown[]): Promise<unknown> {
    const listener = listeners.get('test:greet')
    if (!listener) throw new Error('the handler was not registered')
    return listener(event, ...args)
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    handler.mockClear()
    listeners.clear()
    setRendererEntry({
      filePath: '/Applications/FixLibrary.app/Contents/Resources/app.asar/out/renderer/index.html'
    })
    handleIpc('test:greet', z.tuple([z.string()]), handler)
  })

  it('runs the handler for a call from the main frame of the app page', async () => {
    // Act
    const result = await call(eventFrom(APP_PAGE), 'dj')

    // Assert
    expect(result).toBe('hello dj')
  })

  it.each([
    ['another local file', eventFrom('file:///Users/dj/Downloads/page.html')],
    ['a remote page', eventFrom('https://example.com/')],
    ['a frame inside the app page', eventFrom(APP_PAGE, { subFrame: true })],
    ['a frame that no longer exists', eventFrom(APP_PAGE, { frameGone: true })]
  ])('rejects a call from %s without running the handler', async (_name, event) => {
    // Act
    const outcome = call(event, 'dj')

    // Assert
    await expect(outcome).rejects.toThrow('IPC call from an unknown page')
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ['a wrong type', [42]],
    ['a missing argument', []],
    ['an extra argument', ['dj', 'extra']]
  ])('rejects %s without running the handler', async (_name, args) => {
    // Act
    const outcome = call(eventFrom(APP_PAGE), ...args)

    // Assert
    await expect(outcome).rejects.toThrow('Invalid IPC arguments')
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers a failing handler with a fixed message, keeping the detail in the main process', async () => {
    // Arrange
    handleIpc('test:fail', z.tuple([]), () => {
      throw new Error('EACCES: permission denied, open /Users/dj/secret/path')
    })
    const listener = listeners.get('test:fail')

    // Act
    const outcome = listener?.(eventFrom(APP_PAGE))

    // Assert
    await expect(outcome).rejects.toThrow(/^The request failed$/)
  })
})

describe('isRendererUrl', () => {
  const devEntry = 'http://localhost:5173/'

  it.each([
    ['the built page itself', APP_PAGE, APP_PAGE],
    ['the built page with a hash', `${APP_PAGE}#/settings`, APP_PAGE],
    ['a page of the dev server', 'http://localhost:5173/index.html', devEntry],
    [
      'the same file written with other escapes, as Electron and Node differ',
      'file:///Users/dj/Apps%20[DJ]/100%25/index.html',
      'file:///Users/dj/Apps%20%5BDJ%5D/100%25/index.html'
    ],
    [
      'a path with an accent',
      'file:///Users/dj/Zen%C3%A9k/index.html',
      'file:///Users/dj/Zenék/index.html'
    ]
  ])('accepts %s', (_name, candidate, entry) => {
    // Act
    const trusted = isRendererUrl(candidate, entry)

    // Assert
    expect(trusted).toBe(true)
  })

  it.each([
    [
      'another local file, such as one dropped on the window',
      'file:///Users/dj/Downloads/page.html',
      APP_PAGE
    ],
    ['a remote page', 'https://example.com/', APP_PAGE],
    ['a remote page while developing', 'https://example.com/', devEntry],
    ['another port on localhost', 'http://localhost:9999/', devEntry],
    ['a local file while developing', APP_PAGE, devEntry],
    ['a blob created on the dev server origin', 'blob:http://localhost:5173/1234', devEntry],
    [
      'the same path on another host',
      'file://otherhost/Applications/FixLibrary.app/Contents/Resources/app.asar/out/renderer/index.html',
      APP_PAGE
    ],
    ['something that is not a URL', 'not a url', APP_PAGE],
    ['an empty frame URL', '', APP_PAGE]
  ])('rejects %s', (_name, candidate, entry) => {
    // Act
    const trusted = isRendererUrl(candidate, entry)

    // Assert
    expect(trusted).toBe(false)
  })
})
