/**
 * Plugin-level tests: the two seams and the tool surface, driven through a
 * fake Cordis context and a fake gateway. These assert what the harness
 * actually observes — an injected user message, an L0 capture call, and the
 * registered tool names — rather than internal helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

/** The subset of a registered tool these tests drive. */
interface ToolStub {
  name: string
  description: string
  execute: (args: Record<string, unknown>) => unknown
}

/** One recorded gateway call. */
interface Call {
  path: string
  body: unknown
}

const silentLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }

/** Minimal Cordis context recording the registrations a plugin makes. */
function fakeContext() {
  const preSteps: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
  const turnStopping: Array<(payload: unknown) => Promise<void>> = []
  const tools = new Map<string, ToolStub>()
  const ctx = {
    logger: silentLogger,
    on(name: string, handler: unknown) {
      if (name === 'agent/pre-step') preSteps.push(handler as never)
      if (name === 'agent/turn-stopping') turnStopping.push(handler as never)
    },
    effect() { /* disposal is covered by the sidecar tests */ },
    tools: {
      register(tool: ToolStub) {
        tools.set(tool.name, tool)
      },
    },
  }
  return { ctx, preSteps, turnStopping, tools }
}

/** Session surface the plugin reads: user turn plus the assistant reply. */
function fakeAgent() {
  const events = new Map<number, unknown>([
    [0, { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: 'I prefer lapsang tea' }], source: { kind: 'user' } } }],
    [1, { type: 'assistant/message', time: 20, data: { turn: 1, message: { content: [{ type: 'text', text: 'Noted.' }] } } }],
  ])
  return {
    session: {
      id: 'session-1',
      surface: { nodes: [0, 1] },
      eventAt: (seq: number) => events.get(seq),
    },
  }
}

describe('memory-tdai plugin', () => {
  let server: Server
  let baseUrl: string
  let calls: Call[]
  let reply: (path: string) => unknown

  beforeEach(async () => {
    calls = []
    reply = () => ({ code: 0, data: {} })
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        calls.push({ path: request.url ?? '', body: raw === '' ? undefined : JSON.parse(raw) })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply(request.url ?? '')))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  const config = (overrides: Config = {}): Config => {
    const merged: Config = { baseUrl }
    Object.assign(merged, overrides)
    return merged
  }

  it('injects persona and memories once on the first step', async () => {
    reply = (path) => {
      if (path === '/v2/core/read') return { code: 0, data: { content: '- prefers lapsang' } }
      if (path === '/v2/atomic/search') return { code: 0, data: { items: [{ content: 'lives in Shanghai' }] } }
      return { code: 0, data: {} }
    }
    const { ctx, preSteps } = fakeContext()
    apply(ctx as never, config())
    expect(preSteps).toHaveLength(1)

    const decision = await preSteps[0]!(
      { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: 'what do I drink?' }] }] }),
    ) as { messages: Array<{ source: { kind: string }; content: Array<{ text: string }> }> }

    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source.kind).toBe('memory-tdai')
    expect(injected.content[0]!.text).toContain('prefers lapsang')
    expect(injected.content[0]!.text).toContain('lives in Shanghai')
    expect(calls.map(call => call.path).sort()).toEqual(['/v2/atomic/search', '/v2/core/read'])
  })

  it('does not inject twice for the same turn or on later steps', async () => {
    reply = () => ({ code: 0, data: { items: [{ content: 'remembered' }] } })
    const { ctx, preSteps } = fakeContext()
    apply(ctx as never, config())
    const agent = fakeAgent()
    const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal }
    const next = async () => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

    const first = await preSteps[0]!(payload, next) as { messages: unknown[] }
    expect(first.messages).toHaveLength(2)
    const again = await preSteps[0]!(payload, next) as { messages: unknown[] }
    expect(again.messages).toHaveLength(1)

    const later = await preSteps[0]!({ ...payload, step: 2 }, next) as { messages: unknown[] }
    expect(later.messages).toHaveLength(1)
  })

  it('leaves the decision untouched when the gateway is down', async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    baseUrl = 'http://127.0.0.1:1'
    const { ctx, preSteps } = fakeContext()
    apply(ctx as never, { baseUrl, recall: { enabled: true, timeoutMs: 100, maxChars: 500, limit: 3 } })
    const decision = await preSteps[0]!(
      { agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    ) as { kind: string; messages: unknown[] }
    expect(decision.kind).toBe('continue')
    expect(decision.messages).toHaveLength(1)
    server = createServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  it('captures the finished turn to L0', async () => {
    const { ctx, turnStopping } = fakeContext()
    apply(ctx as never, config())
    expect(turnStopping).toHaveLength(1)
    await turnStopping[0]!({ agent: fakeAgent(), turn: 1, signal: new AbortController().signal })
    const capture = calls.find(call => call.path === '/v2/conversation/add')
    expect(capture?.body).toMatchObject({
      session_id: 'session-1',
      messages: [
        { role: 'user', content: 'I prefer lapsang tea' },
        { role: 'assistant', content: 'Noted.' },
      ],
    })
  })

  it('skips capture when the gateway rejects the write', async () => {
    reply = () => ({ code: 9, message: 'nope' })
    const { ctx, turnStopping } = fakeContext()
    apply(ctx as never, config())
    await expect(turnStopping[0]!({ agent: fakeAgent(), turn: 1, signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(silentLogger.warn).toHaveBeenCalled()
  })

  it('registers both search tools and forwards their queries', async () => {
    reply = path => ({
      code: 0,
      data: path === '/v2/atomic/search'
        ? { items: [{ content: 'likes tea', type: 'persona' }] }
        : { messages: [{ content: 'earlier talk' }] },
    })
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    expect([...tools.keys()].sort()).toEqual(['conversation_search', 'memory_search'])

    expect(await tools.get('memory_search')!.execute({ query: 'tea' })).toBe('1. likes tea (persona)')
    expect(await tools.get('conversation_search')!.execute({ query: 'talk', limit: 99 })).toBe('1. earlier talk')
    const search = calls.find(call => call.path === '/v2/atomic/search')
    expect(search?.body).toMatchObject({ query: 'tea', limit: 5 })
    const conversation = calls.find(call => call.path === '/v2/conversation/search')
    expect(conversation?.body).toMatchObject({ query: 'talk', limit: 20 })
  })

  it('reports an empty search instead of an empty string', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    expect(await tools.get('memory_search')!.execute({ query: 'nothing' })).toBe('No matching memory.')
    expect(await tools.get('conversation_search')!.execute({ query: 'nothing' })).toBe('No matching conversation.')
  })

  it('registers nothing when disabled', async () => {
    const { ctx, preSteps, turnStopping, tools } = fakeContext()
    apply(ctx as never, config({ enabled: false }))
    expect(preSteps).toHaveLength(0)
    expect(turnStopping).toHaveLength(0)
    expect(tools.size).toBe(0)
  })
})
