import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverThumbsRequest } from '@shared/preview'
import { useCoverThumbsStore } from './cover-thumbs-store'

const THUMB = 'data:image/jpeg;base64,AAAA'

let asked: CoverThumbsRequest[]

function stubApi(answer: (request: CoverThumbsRequest) => Promise<unknown>): void {
  vi.stubGlobal('window', {
    api: {
      preview: {
        coverThumbs: async (request: CoverThumbsRequest) => {
          asked.push(request)
          return answer(request)
        }
      }
    }
  })
}

async function settled(): Promise<void> {
  await vi.runAllTimersAsync()
}

beforeEach(() => {
  vi.useFakeTimers()
  asked = []
  useCoverThumbsStore.setState(useCoverThumbsStore.getInitialState())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the thumbnails of covers', () => {
  it('asks once for the rows that came into view together', async () => {
    // Arrange
    stubApi(async ({ trackIds }) => ({
      ok: true,
      value: trackIds.map((trackId) => ({
        trackId,
        hadBefore: false,
        before: null,
        beforeSize: null,
        after: THUMB
      }))
    }))
    const { request } = useCoverThumbsStore.getState()

    // Act
    request(7, 1)
    request(7, 2)
    request(7, 1)
    await settled()

    // Assert
    expect(asked).toEqual([{ batchId: 7, trackIds: [1, 2] }])
    expect(useCoverThumbsStore.getState().rows[2]).toEqual({
      status: 'ready',
      trackId: 2,
      hadBefore: false,
      before: null,
      beforeSize: null,
      after: THUMB
    })
  })

  it('asks for no more than a hundred rows in one call', async () => {
    // Arrange
    stubApi(async () => ({ ok: true, value: [] }))
    const { request } = useCoverThumbsStore.getState()

    // Act
    for (let trackId = 1; trackId <= 150; trackId += 1) request(7, trackId)
    await settled()

    // Assert
    expect(asked.map((each) => each.trackIds.length)).toEqual([100, 50])
  })

  it('marks the rows of a call that failed, and asks again when the row is shown again', async () => {
    // Arrange
    stubApi(async () => ({ ok: false, code: 'INVALID_INPUT' }))
    const { request } = useCoverThumbsStore.getState()
    request(7, 1)
    await settled()
    const failed = useCoverThumbsStore.getState().rows[1]

    // Act
    request(7, 1)
    request(7, 1)
    await settled()

    // Assert
    expect(failed).toEqual({ status: 'failed' })
    expect(asked).toHaveLength(2)
  })

  it('forgets the rows of another batch', async () => {
    // Arrange
    stubApi(async ({ trackIds }) => ({
      ok: true,
      value: trackIds.map((trackId) => ({
        trackId,
        hadBefore: false,
        before: null,
        beforeSize: null,
        after: THUMB
      }))
    }))
    const { request } = useCoverThumbsStore.getState()
    request(7, 1)
    await settled()

    // Act
    request(8, 2)
    await settled()

    // Assert
    expect(Object.keys(useCoverThumbsStore.getState().rows)).toEqual(['2'])
    expect(asked.map((each) => each.batchId)).toEqual([7, 8])
  })
})
