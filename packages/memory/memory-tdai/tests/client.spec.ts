/**
 * Wire-level tests for the gateway client: envelope handling, transport
 * failures, and each verb's path, headers, and body. A local HTTP server stands
 * in for the real gateway so the v2 contract is asserted without a sidecar.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GatewayError, MemoryGatewayClient } from '../src/client.ts'
import { Config, resolveConfig } from '../src/config.ts'

/** One recorded request. */
interface Recorded {
  method: string
  path: string
  body: unknown
  headers: IncomingMessage['headers']
}

describe('resolveConfig', () => {
  it('applies every default', () => {
    expect(resolveConfig({})).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8420',
      apiKeyEnv: undefined,
      serviceId: 'default',
      recall: { enabled: true, timeoutMs: 1500, maxChars: 2000, limit: 5 },
      capture: { enabled: true, minIntervalMs: 0 },
      tools: { enabled: true },
      sidecar: { autoStart: false, command: undefined, logDir: undefined, startupTimeoutMs: 20000, env: {} },
    })
  })

  it('strips a trailing slash from the origin', () => {
    expect(resolveConfig({ baseUrl: 'http://127.0.0.1:9999//' }).baseUrl).toBe('http://127.0.0.1:9999')
  })

  it('rejects autoStart without a command', () => {
    expect(() => resolveConfig({ sidecar: { autoStart: true, startupTimeoutMs: 20000 } })).toThrow(/requires sidecar\.command/)
  })

  it('accepts autoStart with a command', () => {
    expect(resolveConfig({ sidecar: { autoStart: true, command: 'gateway', startupTimeoutMs: 20000 } }).sidecar.command).toBe('gateway')
  })

  it('validates the schema defaults', () => {
    expect(Config({})).toMatchObject({ enabled: true, recall: { limit: 5 } })
  })
})

describe('MemoryGatewayClient', () => {
  let server: Server
  let baseUrl: string
  let recorded: Recorded[]
  let respond: (request: IncomingMessage, response: ServerResponse) => void

  beforeEach(async () => {
    recorded = []
    respond = (_request, response) => {
      response.writeHead(404)
      response.end()
    }
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        recorded.push({
          method: request.method ?? '',
          path: request.url ?? '',
          body: raw === '' ? undefined : JSON.parse(raw),
          headers: request.headers,
        })
        respond(request, response)
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  const client = (apiKey?: string): MemoryGatewayClient =>
    new MemoryGatewayClient({ baseUrl, serviceId: 'svc', apiKeyEnv: 'TOKEN' }, apiKey)

  it('reports ok, degraded, and down', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    }
    expect(await client().health()).toBe('ok')

    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'degraded' }))
    }
    expect(await client().health()).toBe('degraded')

    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'unknown' }))
    }
    expect(await client().health()).toBe('down')

    respond = (_request, response) => {
      response.writeHead(500)
      response.end()
    }
    expect(await client().health()).toBe('down')
  })

  it('reports down when nothing listens', async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(await client().health()).toBe('down')
    server = createServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  })

  it('writes L0 conversations with the service header and a bearer token', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { accepted_ids: ['a'], total_count: 1 } }))
    }
    await client('secret').addConversation(
      [
        { role: 'user', content: 'hi', timestamp: '2026-11-09T03:00:00.000Z' },
        { role: 'assistant', content: 'hello' },
      ],
      'session-1',
    )
    expect(recorded[0]?.path).toBe('/v2/conversation/add')
    expect(recorded[0]?.body).toEqual({
      session_id: 'session-1',
      messages: [
        { role: 'user', content: 'hi', timestamp: '2026-11-09T03:00:00.000Z' },
        { role: 'assistant', content: 'hello' },
      ],
    })
    expect(recorded[0]?.headers.authorization).toBe('Bearer secret')
    expect(recorded[0]?.headers['x-tdai-service-id']).toBe('svc')
  })

  it('falls back to a placeholder bearer that standalone gateways accept', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: {} }))
    }
    await client('').addConversation([{ role: 'user', content: 'hi' }], 'session-1')
    expect(recorded[0]?.headers.authorization).toBe('Bearer dsh')
  })

  it('skips an empty capture', async () => {
    await client().addConversation([], 'session-1')
    expect(recorded).toHaveLength(0)
  })

  it('reads L1 items from atomic search', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { items: [{ content: 'likes tea', score: 0.9, type: 'persona' }] } }))
    }
    expect(await client().searchMemories('drink', 3)).toEqual([{ content: 'likes tea', score: 0.9, type: 'persona' }])
    expect(recorded[0]?.path).toBe('/v2/atomic/search')
    expect(recorded[0]?.body).toEqual({ query: 'drink', limit: 3 })
  })

  it('reads L0 messages from conversation search', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { messages: [{ content: 'earlier chat', role: 'user' }] } }))
    }
    expect(await client().searchConversations('earlier', 2)).toEqual([{ content: 'earlier chat', role: 'user' }])
    expect(recorded[0]?.path).toBe('/v2/conversation/search')
    expect(recorded[0]?.body).toEqual({ query: 'earlier', limit: 2 })
  })

  it('returns an empty list when a verb answers without its collection', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: {} }))
    }
    expect(await client().searchMemories('x', 1)).toEqual([])
    expect(await client().searchConversations('x', 1)).toEqual([])
  })

  it('reads the persona content and tolerates a null one', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { content: '# Persona\n- prefers tea' } }))
    }
    expect(await client().readPersona()).toBe('# Persona\n- prefers tea')
    expect(recorded[0]?.path).toBe('/v2/core/read')

    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { content: null } }))
    }
    expect(await client().readPersona()).toBe('')
  })

  it('throws on a non-zero envelope code', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 7, message: 'quota' }))
    }
    await expect(client().readPersona()).rejects.toThrow('quota')
  })

  it('throws on an HTTP error and on malformed bodies', async () => {
    respond = (_request, response) => {
      response.writeHead(503)
      response.end('nope')
    }
    await expect(client().readPersona()).rejects.toBeInstanceOf(GatewayError)

    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('not json')
    }
    await expect(client().readPersona()).rejects.toThrow(/non-JSON/)
  })

  it('treats an empty body as no payload', async () => {
    respond = (_request, response) => {
      response.writeHead(200)
      response.end()
    }
    expect(await client().readPersona()).toBe('')
  })

  it('honours a tighter timeout budget', async () => {
    respond = () => { /* never answers */ }
    await expect(client().withTimeout(50).health()).resolves.toBe('down')
  })
})
