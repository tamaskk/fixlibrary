import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RPC_TIMEOUT_MS,
  ENGINE_CHECK_TIMEOUT_MS,
  STAGE_TIMEOUTS_MS,
  TAG_BATCH_TIMEOUT_MS
} from './timeouts'

describe('STAGE_TIMEOUTS_MS', () => {
  it('holds the documented limit of every stage', () => {
    // Assert
    expect(STAGE_TIMEOUTS_MS).toEqual({
      lookup: 30_000,
      bpmKey: 120_000,
      energy: 120_000,
      demucs: 900_000,
      convert: 120_000,
      normalize: 120_000
    })
  })

  it('gives a plain sidecar call thirty seconds', () => {
    // Assert
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(30_000)
  })

  it('gives one batch of tag reading two minutes', () => {
    // Assert
    expect(TAG_BATCH_TIMEOUT_MS).toBe(120_000)
  })

  it('waits fifteen seconds for the sidecar to say it is alive', () => {
    // Assert
    expect(ENGINE_CHECK_TIMEOUT_MS).toBe(15_000)
  })
})
