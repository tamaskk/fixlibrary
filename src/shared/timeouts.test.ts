import { describe, expect, it } from 'vitest'
import {
  COVER_RPC_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  ENGINE_CHECK_TIMEOUT_MS,
  JOB_CANCEL_TIMEOUT_MS,
  STAGE_TIMEOUTS_MS,
  TAG_BATCH_TIMEOUT_MS
} from './timeouts'

describe('STAGE_TIMEOUTS_MS', () => {
  it('holds the documented limit of every stage', () => {
    // Assert
    expect(STAGE_TIMEOUTS_MS).toEqual({
      lookup: 30_000,
      fingerprint: 120_000,
      naming: 10_000,
      rename: 300_000,
      duplicates: 10_000,
      setAside: 300_000,
      bpmKey: 120_000,
      energy: 120_000,
      demucs: 900_000,
      convert: 120_000,
      tags: 120_000,
      writeTags: 360_000,
      convertFile: 360_000,
      normalize: 120_000,
      cover: 60_000,
      embedCover: 360_000,
      style: 420_000,
      organize: 10_000,
      organizeFile: 360_000
    })
  })

  it('gives one cover call twenty seconds', () => {
    // Assert
    expect(COVER_RPC_TIMEOUT_MS).toBe(20_000)
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

  it('gives a job in the sidecar five seconds to stop', () => {
    // Assert
    expect(JOB_CANCEL_TIMEOUT_MS).toBe(5000)
  })
})
