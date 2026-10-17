import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { cues } from '../db/schema'
import { setSetting } from '../db/settings'
import { insertTracks } from '../db/tracks'
import { logger } from '../services/logger'
import { locationOf } from '../services/rekordbox-xml'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { PHASE_A_STEPS, type WizardState } from '@shared/rekordbox-wizard'
import {
  applyWizardAction,
  checkWizardCues,
  checkWizardExport,
  readWizardState,
  readWizardView,
  type WizardDependencies
} from './rekordbox-wizard'

let testDatabase: TestDatabase
let folder: string
let generated: string
let exports: string
let clock: number

function dependencies(): WizardDependencies {
  return {
    db: testDatabase.db,
    environment: { homeDir: folder, cpuCount: 4 },
    listMountedVolumes: () => new Set(),
    isBusy: () => false,
    now: () => clock
  }
}

async function done(state: WizardState['step']): Promise<WizardState> {
  const result = await applyWizardAction(dependencies(), { type: 'complete', step: state })
  if (!result.ok) throw new Error(`${state}: ${result.code}`)
  return result.value
}

/** Takes the wizard to the check of phase A, the XML written. */
async function atCheck(beforeExportStep: () => void = () => {}): Promise<void> {
  await done('setup.showXml')
  await done('setup.importedLibrary')
  writeFileSync(join(generated, 'fixlibrary.xml'), '<x/>')
  for (const step of PHASE_A_STEPS.slice(0, -1)) {
    if (step === 'a.reloadTag') beforeExportStep()
    await done(step)
  }
}

function writeExport(paths: string[], grid: boolean, marks = '', bpm = '124'): void {
  const tracks = paths
    .map(
      (path, index) =>
        `<TRACK TrackID="${index + 1}" Location="${locationOf(path)}">${grid ? `<TEMPO Inizio="0" Bpm="${bpm}" Metro="4/4" Battito="1"/>` : ''}${marks}</TRACK>`
    )
    .join('')
  writeFileSync(
    join(exports, 'rekordbox.xml'),
    `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION>${tracks}</COLLECTION></DJ_PLAYLISTS>`
  )
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-wizard-')))
  generated = join(folder, 'Generated')
  exports = join(folder, 'Exports')
  mkdirSync(generated)
  mkdirSync(exports)
  // Ahead of the files the test writes, which take the real time: what a step wrote is newer.
  clock = Date.now() - 60_000
  setSetting(testDatabase.db, 'rekordbox', {
    ...DEFAULT_SETTINGS.rekordbox,
    generatedXmlFolder: generated,
    exportedXmlFolder: exports
  })
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the Rekordbox wizard', () => {
  it('starts with the setup and names the XML and the export folder', async () => {
    // Act
    const view = await readWizardView(dependencies())

    // Assert
    expect(view).toEqual({
      state: { setupDone: false, step: 'setup.showXml', enteredAt: 0, exportFrom: null },
      xmlWritten: false,
      xmlPath: join(generated, 'fixlibrary.xml'),
      exportFolder: exports,
      phaseBLocked: false
    })
  })

  it('goes from the setup to phase A, and keeps where it is when opened again', async () => {
    // Act
    await done('setup.showXml')
    await done('setup.importedLibrary')
    const reopened = readWizardState(testDatabase.reopen())

    // Assert
    expect(reopened).toMatchObject({ setupDone: true, step: 'a.writeXml' })
  })

  it('does not take the XML step as done before the XML is there', async () => {
    // Arrange
    await done('setup.showXml')
    await done('setup.importedLibrary')

    // Act
    const early = await applyWizardAction(dependencies(), { type: 'complete', step: 'a.writeXml' })
    writeFileSync(join(generated, 'fixlibrary.xml'), '<x/>')
    const later = await applyWizardAction(dependencies(), { type: 'complete', step: 'a.writeXml' })

    // Assert
    expect(early).toEqual({ ok: false, code: 'XML_NOT_FOUND' })
    expect(later).toMatchObject({ ok: true, value: { setupDone: true, step: 'a.refresh' } })
  })

  it.each([
    ['a step it is not at', { type: 'complete', step: 'a.export' }],
    ['a step it has not reached', { type: 'goTo', step: 'a.export' }],
    ['a step of the locked phase B', { type: 'goTo', step: 'b.writeXml' }],
    ['what is no action', { type: 'jump', step: 'a.check' }],
    ['a step of the setup ahead', { type: 'goTo', step: 'setup.importedLibrary' }],
    ['phase A again before the setup', { type: 'restart' }]
  ])('refuses %s', async (_what, action) => {
    // Act
    const result = await applyWizardAction(dependencies(), action)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(readWizardState(testDatabase.db)).toMatchObject({
      setupDone: false,
      step: 'setup.showXml'
    })
  })

  it('goes back to a step that was done, and starts phase A again keeping the setup', async () => {
    // Arrange
    await atCheck()

    // Act
    const back = await applyWizardAction(dependencies(), { type: 'goTo', step: 'a.importTracks' })
    const restarted = await applyWizardAction(dependencies(), { type: 'restart' })

    // Assert
    expect(back).toMatchObject({ ok: true, value: { setupDone: true, step: 'a.importTracks' } })
    expect(restarted).toMatchObject({ ok: true, value: { setupDone: true, step: 'a.writeXml' } })
  })

  it('does not let the check be marked done by hand', async () => {
    // Arrange
    await atCheck()

    // Act
    const result = await applyWizardAction(dependencies(), { type: 'complete', step: 'a.check' })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('stays at the check and names the steps to do again while the export is not clean', async () => {
    // Arrange
    const path = join(folder, 'a.mp3')
    writeFileSync(path, 'audio')
    insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'mp3' }])
    await atCheck()
    writeExport([path], false)

    // Act
    const result = await checkWizardExport(dependencies())

    // Assert
    expect(result).toMatchObject({
      ok: true,
      value: {
        verdict: { clean: false, repeat: ['a.waitAnalysis'], holds: [] },
        state: { step: 'a.check' }
      }
    })
    expect(readWizardState(testDatabase.db).step).toBe('a.check')
  })

  it('goes on to phase B when the export of phase A is clean', async () => {
    // Arrange
    const path = join(folder, 'a.mp3')
    writeFileSync(path, 'audio')
    insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'mp3' }])
    await atCheck()
    writeExport([path], true)

    // Act
    const result = await checkWizardExport(dependencies())

    // Assert
    expect(result).toMatchObject({
      ok: true,
      value: { verdict: { clean: true }, state: { setupDone: true, step: 'b.writeXml' } }
    })
  })

  it('checks only at the check', async () => {
    // Act
    const result = await checkWizardExport(dependencies())

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('does not take an XML written before the step was reached', async () => {
    // Arrange
    await done('setup.showXml')
    writeFileSync(join(generated, 'fixlibrary.xml'), '<old/>')
    clock = Date.now() + 60_000
    await done('setup.importedLibrary')

    // Act
    const result = await applyWizardAction(dependencies(), { type: 'complete', step: 'a.writeXml' })
    const view = await readWizardView(dependencies())

    // Assert
    expect(result).toEqual({ ok: false, code: 'XML_NOT_FOUND' })
    expect(view.xmlWritten).toBe(false)
  })

  it('does not pass an export made before the export step was reached', async () => {
    // Arrange
    writeExport([], true)
    await atCheck(() => {
      clock = Date.now() + 60_000
    })

    // Act
    const result = await checkWizardExport(dependencies())

    // Assert
    expect(result).toMatchObject({
      ok: true,
      value: { verdict: { clean: false, holds: ['stale'] }, state: { step: 'a.check' } }
    })
  })

  it('saves nothing of a check when the wizard was moved while the export was read', async () => {
    // Arrange
    await atCheck()
    writeExport([], true)
    const moving: WizardDependencies = {
      ...dependencies(),
      parseExport: async (bytes) => {
        await applyWizardAction(dependencies(), { type: 'goTo', step: 'a.importTracks' })
        const { parseRekordboxBytes } = await import('../services/rekordbox-xml-read')
        return parseRekordboxBytes(bytes)
      }
    }

    // Act
    const result = await checkWizardExport(moving)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(readWizardState(testDatabase.db).step).toBe('a.importTracks')
  })

  it('starts again when what is stored cannot be read', async () => {
    // Arrange
    setSetting(testDatabase.db, 'rekordboxWizard', { setupDone: true, step: 'a.renamedStep' })

    // Act
    const view = await readWizardView(dependencies())

    // Assert
    expect(view.state).toEqual({
      setupDone: false,
      step: 'setup.showXml',
      enteredAt: 0,
      exportFrom: null
    })
  })

  describe('phase B', () => {
    /** One track of the library with its grid read and a hot cue placed; the wizard at B's check. */
    async function atCueCheck(): Promise<string> {
      const path = join(folder, 'a.mp3')
      writeFileSync(path, 'audio')
      const [id] = insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'mp3' }]) as [
        number
      ]
      await atCheck()
      writeExport([path], true)
      const passed = await checkWizardExport(dependencies())
      if (!passed.ok || passed.value.state.step !== 'b.writeXml')
        throw new Error('phase A not passed')
      testDatabase.db
        .insert(cues)
        .values({ trackId: id, slot: 4, positionMs: 61_960, name: 'Drop 1', color: '#ef4444' })
        .run()
      writeFileSync(join(generated, 'fixlibrary.xml'), '<x/>')
      for (const step of ['b.writeXml', 'b.import', 'b.export'] as const) await done(step)
      return path
    }

    it('ends the wizard when every hot cue is in place and the grid is the one read before', async () => {
      // Arrange
      const path = await atCueCheck()
      writeExport([path], true, '<POSITION_MARK Name="Drop 1" Type="0" Start="61.952" Num="3"/>')

      // Act
      const result = await checkWizardCues(dependencies())

      // Assert
      expect(result).toMatchObject({
        ok: true,
        value: { verdict: { clean: true }, state: { step: 'doneB' } }
      })
    })

    it('names a hot cue that is not in place, and a grid Rekordbox moved', async () => {
      // Arrange
      const path = await atCueCheck()
      writeExport(
        [path],
        true,
        '<POSITION_MARK Name="Drop 1" Type="0" Start="61.940" Num="3"/>',
        '125'
      )

      // Act
      const result = await checkWizardCues(dependencies())

      // Assert
      expect(result).toMatchObject({
        ok: true,
        value: {
          verdict: {
            clean: false,
            mismatches: {
              count: 1,
              items: [{ slot: 4, expectedMs: 61_960, foundMs: 61_940, path }]
            },
            gridChanged: { count: 1, items: [{ path }] }
          },
          state: { step: 'b.check' }
        }
      })
    })

    it('does not pass when no hot cue was placed, since nothing was checked', async () => {
      // Arrange
      const path = await atCueCheck()
      testDatabase.db.delete(cues).run()
      writeExport([path], true)

      // Act
      const result = await checkWizardCues(dependencies())

      // Assert
      expect(result).toMatchObject({
        ok: true,
        value: { verdict: { clean: false, noCues: true }, state: { step: 'b.check' } }
      })
    })

    it('still finds the moved grid on a second check of the same export', async () => {
      // Arrange
      const path = await atCueCheck()
      writeExport(
        [path],
        true,
        '<POSITION_MARK Name="Drop 1" Type="0" Start="61.952" Num="3"/>',
        '125'
      )
      await checkWizardCues(dependencies())
      clock += 5_000

      // Act
      const result = await checkWizardCues(dependencies())

      // Assert
      expect(result).toMatchObject({
        ok: true,
        value: { verdict: { clean: false, gridChanged: { count: 1 } } }
      })
    })

    it('does not take the XML of phase B as written before its step', async () => {
      // Arrange
      await atCueCheck()
      await applyWizardAction(dependencies(), { type: 'goTo', step: 'b.writeXml' })

      // Act
      clock = Date.now() + 60_000
      await applyWizardAction(dependencies(), { type: 'goTo', step: 'b.writeXml' })
      const result = await applyWizardAction(dependencies(), {
        type: 'complete',
        step: 'b.writeXml'
      })

      // Assert
      expect(result).toEqual({ ok: false, code: 'XML_NOT_FOUND' })
    })
  })
})
