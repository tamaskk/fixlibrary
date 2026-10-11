import { describe, expect, it } from 'vitest'
import { encodeRpcRequest, parseRpcLine, RPC_SCHEMAS } from './rpc'

describe('encodeRpcRequest', () => {
  it('writes one JSON-RPC 2.0 request per line', () => {
    // Arrange
    const params = { value: 'a\nb' }

    // Act
    const line = encodeRpcRequest(7, 'echo', params)

    // Assert
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd()).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 7, method: 'echo', params })
  })
})

describe('parseRpcLine', () => {
  it('reads a result response', () => {
    // Arrange
    const line = '{"jsonrpc":"2.0","id":3,"result":{"version":"0.1.0"}}'

    // Act
    const message = parseRpcLine(line)

    // Assert
    expect(message).toEqual({ kind: 'result', id: 3, result: { version: '0.1.0' } })
  })

  it('reads a null result', () => {
    // Arrange
    const line = '{"jsonrpc":"2.0","id":4,"result":null}'

    // Act
    const message = parseRpcLine(line)

    // Assert
    expect(message).toEqual({ kind: 'result', id: 4, result: null })
  })

  it('reads an error response, also when the sidecar could not read the id', () => {
    // Arrange
    const line = '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}'

    // Act
    const message = parseRpcLine(line)

    // Assert
    expect(message).toEqual({ kind: 'error', id: null, code: -32700, message: 'Parse error' })
  })

  it('reads a progress notification', () => {
    // Arrange
    const line = '{"jsonrpc":"2.0","method":"progress","params":{"jobId":"j-1","percent":40}}'

    // Act
    const message = parseRpcLine(line)

    // Assert
    expect(message).toEqual({ kind: 'progress', progress: { jobId: 'j-1', percent: 40 } })
  })

  it.each([
    ['a stray print', 'Loading model...'],
    ['a JSON value that is not an object', '42'],
    ['a response without an id', '{"jsonrpc":"2.0","result":1}'],
    ['a response with a string id', '{"jsonrpc":"2.0","id":"3","result":1}'],
    ['a wrong protocol version', '{"jsonrpc":"1.0","id":3,"result":1}'],
    ['an error without a message', '{"jsonrpc":"2.0","id":3,"error":{"code":1}}'],
    ['an unknown notification', '{"jsonrpc":"2.0","method":"log","params":{}}'],
    [
      'progress above 100 percent',
      '{"jsonrpc":"2.0","method":"progress","params":{"jobId":"j-1","percent":140}}'
    ]
  ])('rejects %s', (_name, line) => {
    // Act
    const message = parseRpcLine(line)

    // Assert
    expect(message).toBeNull()
  })
})

describe('RPC_SCHEMAS', () => {
  it('rejects a ping result without a version', () => {
    // Arrange
    const result = { ok: true }

    // Act
    const parsed = RPC_SCHEMAS.ping.result.safeParse(result)

    // Assert
    expect(parsed.success).toBe(false)
  })
})
