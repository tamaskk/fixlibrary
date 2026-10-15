import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STYLES,
  secretInputSchema,
  settingsPatchSchema,
  settingsSchema,
  styleListSchema,
  UNSORTED_STYLE_NAME,
  styleNameSchema,
  newStyleNameSchema,
  newStylesTaken
} from './settings'

describe('DEFAULT_SETTINGS', () => {
  it('is a valid settings object', () => {
    // Act
    const parsed = settingsSchema.safeParse(DEFAULT_SETTINGS)

    // Assert
    expect(parsed.success).toBe(true)
  })

  it('matches the documented loudness defaults: -11 LUFS, lossless', () => {
    // Assert
    expect(DEFAULT_SETTINGS.loudness).toEqual({ targetLufs: -11, method: 'lossless' })
  })

  it('names the eight hot cues as the product spec does, A to H', () => {
    // Act
    const names = DEFAULT_SETTINGS.hotCues.map((cue) => cue.name)

    // Assert
    expect(names).toEqual([
      'Start',
      'Bassline',
      'Vocal',
      'Drop 1',
      'Breakdown',
      'Drop 2',
      'Outro',
      'Drop 3'
    ])
  })

  it('leaves the worker count automatic and keeps originals untouched by default', () => {
    // Assert
    expect(DEFAULT_SETTINGS.performance.workerCount).toBeNull()
    expect(DEFAULT_SETTINGS.analysis).toEqual({ bpmMin: 85, bpmMax: 175 })
    expect(DEFAULT_SETTINGS.library.mode).toBe('clean_library')
  })
})

describe('DEFAULT_STYLES', () => {
  it('lists the documented styles in order and is a valid list', () => {
    // Act
    const names = DEFAULT_STYLES.map((style) => style.name)
    const parsed = styleListSchema.safeParse(DEFAULT_STYLES)

    // Assert
    expect(names).toEqual([
      'Afro House',
      'Organic House',
      'Melodic House',
      'Tech House',
      'Latin House',
      'Unsorted'
    ])
    expect(parsed.success).toBe(true)
  })
})

describe('settingsPatchSchema', () => {
  it('accepts the fields the renderer may change', () => {
    // Arrange
    const patch = {
      library: { mode: 'in_place' },
      loudness: { targetLufs: -8 },
      performance: { workerCount: 4 }
    }

    // Act
    const parsed = settingsPatchSchema.safeParse(patch)

    // Assert
    expect(parsed.success).toBe(true)
  })

  it.each([
    ['a folder path', { library: { rootFolder: '/Volumes/DJ SSD' } }],
    ['a Rekordbox folder', { rekordbox: { generatedXmlFolder: '/tmp' } }],
    ['an unknown group', { secrets: { acoustid: 'x' } }],
    ['a target outside the range', { loudness: { targetLufs: 0 } }],
    ['seven hot cues', { hotCues: DEFAULT_SETTINGS.hotCues.slice(0, 7) }],
    [
      'a color that is not hex',
      { hotCues: DEFAULT_SETTINGS.hotCues.map((c) => ({ ...c, color: 'red' })) }
    ]
  ])('rejects %s', (_name, patch) => {
    // Act
    const parsed = settingsPatchSchema.safeParse(patch)

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('styleListSchema', () => {
  const style = (name: string): { name: string; color: string; isHouse: boolean } => ({
    name,
    color: '#000000',
    isHouse: true
  })

  it.each([
    ['a list without Unsorted', [style('Tech House')]],
    [
      'the same name twice, ignoring case',
      [style('Tech House'), style('tech house'), style(UNSORTED_STYLE_NAME)]
    ],
    ['a name with a path separator', [style('House/Deep'), style(UNSORTED_STYLE_NAME)]],
    ['a hidden-folder name', [style('.hidden'), style(UNSORTED_STYLE_NAME)]],
    ['an empty name', [style('  '), style(UNSORTED_STYLE_NAME)]]
  ])('rejects %s', (_name, styles) => {
    // Act
    const parsed = styleListSchema.safeParse(styles)

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('secretInputSchema', () => {
  it('trims the pasted key', () => {
    // Act
    const parsed = secretInputSchema.parse({ name: 'acoustid', value: '  abc123XYZ \n' })

    // Assert
    expect(parsed.value).toBe('abc123XYZ')
  })

  it.each(['', 'two words', 'line\nbreak', 'x'.repeat(201)])('rejects %j', (value) => {
    // Act
    const parsed = secretInputSchema.safeParse({ name: 'acoustid', value })

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('the names of styles', () => {
  it.each([
    '_Duplicates',
    'duplicates',
    'FixLibrary Backups',
    'Inbox',
    'Hip*Hop',
    'R&B?',
    'Deep.',
    'a<b'
  ])('refuses %s as a name a style may have', (name) => {
    // Act
    const parsed = styleNameSchema.safeParse(name)

    // Assert
    expect(parsed.success).toBe(false)
  })

  it('keeps a new style name to a plain genre name', () => {
    // Act
    const taken = ['Hip Hop', 'Drum & Bass', "Rock 'n' Roll", 'UK Garage'].map(
      (name) => newStyleNameSchema.safeParse(name).success
    )
    const refused = ['Тrap', 'Hip/Hop', 'Unsorted', 'One Two Three Four Five', 'x'.repeat(31)].map(
      (name) => newStyleNameSchema.safeParse(name).success
    )

    // Assert
    expect(taken).toEqual([true, true, true, true])
    expect(refused).toEqual([false, false, false, false, false])
  })

  it('lets a batch create the first five new styles its rows name, as names are compared', () => {
    // Act
    const taken = newStylesTaken(['Trap', 'trap', 'Dubstep', 'Garage', 'Jungle', 'Grime', 'Drill'])

    // Assert
    expect(taken).toEqual(['Trap', 'Dubstep', 'Garage', 'Jungle', 'Grime'])
  })
})
