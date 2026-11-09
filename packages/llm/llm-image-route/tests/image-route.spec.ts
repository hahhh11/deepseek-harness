import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as imageRoute from '../src/index.ts'

const contexts: Context[] = []

class CatalogAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly models: readonly LlmModelInfo[],
    private readonly resolved: ReadonlyMap<string, LlmResolvedModelInfo>,
  ) { super() }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.resolved.get(`${provider}/${model}`)
    if (entry === undefined) throw new Error(`unknown fixture model ${provider}/${model}`)
    return Promise.resolve(entry)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function selection(provider: string, model: string): ModelSelection {
  return { provider, model }
}

function model(provider: string, id: string, image: boolean): LlmResolvedModelInfo {
  return { provider, id, name: id, inputModalities: image ? ['text', 'image'] : ['text'] }
}

function catalog(provider: string, id: string, image: boolean): LlmModelInfo {
  return { provider, id, name: id, inputModalities: image ? ['text', 'image'] : ['text'] }
}

function imageMessage() {
  return createUserMessage({
    source: { kind: 'test' },
    content: [{
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }],
  })
}

async function mount(config: imageRoute.Config | undefined, adapter: CatalogAdapter, providers: string[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(providers, adapter)
  const policy = await ctx.plugin({ inject: imageRoute.inject, Config: imageRoute.Config, apply: imageRoute.apply }, config)
  await mountAgentLoopTestHarness(ctx)
  return { ctx, policy }
}

async function ask(
  ctx: Context,
  id: string,
  selected: ModelSelection,
  message: UserMessage = imageMessage(),
) {
  const agent = await ctx.agentLoop.create(SessionId(id), selected)
  agent.followup(message)
  await agent.whenIdle()
  return agent
}

describe('image model route', () => {
  it('activates without an explicit configuration', async () => {
    const adapter = new CatalogAdapter([], new Map())

    await expect(mount(undefined, adapter, ['route'])).resolves.toBeDefined()
  })

  it('uses the first declared vision model for the request and retains the configured next model', async () => {
    const text = selection('route', 'text')
    const vision = selection('route', 'vision')
    const adapter = new CatalogAdapter([
      catalog('route', 'text', false),
      catalog('route', 'vision', true),
    ], new Map([
      ['route/text', model('route', 'text', false)],
      ['route/vision', model('route', 'vision', true)],
    ]))
    const { ctx } = await mount({}, adapter, ['route'])
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    const agent = await ask(ctx, 'same-provider', text)

    expect(errors).toEqual([])
    expect(adapter.requests[0]).toMatchObject({ provider: 'route', model: 'vision' })
    expect(adapter.requests[0]?.messages).toContainEqual(expect.objectContaining({
      content: [expect.objectContaining({ type: 'image' })],
    }))
    expect(agent.model.current()).toEqual(text)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1))
      .toMatchObject({ data: { header: { config: vision } } })

    agent.followup(createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'continue' }] }))
    await agent.whenIdle()
    expect(adapter.requests[1]).toMatchObject(text)
  })

  it('leaves an image-capable selection and text-only input unchanged', async () => {
    const text = selection('route', 'text')
    const vision = selection('route', 'vision')
    const adapter = new CatalogAdapter([
      catalog('route', 'vision', true),
    ], new Map([
      ['route/text', model('route', 'text', false)],
      ['route/vision', model('route', 'vision', true)],
    ]))
    const { ctx } = await mount({}, adapter, ['route'])

    await ask(ctx, 'already-vision', vision)
    await ask(ctx, 'text-input', text, createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'no image' }] }))

    expect(adapter.requests.map(request => ({ provider: request.provider, model: request.model })))
      .toEqual([vision, text])
  })

  it('uses an explicit cross-provider fallback only when the selected provider has no vision model', async () => {
    const text = selection('text-route', 'text')
    const vision = selection('vision-route', 'vision')
    const adapter = new CatalogAdapter([], new Map([
      ['text-route/text', model('text-route', 'text', false)],
      ['vision-route/vision', model('vision-route', 'vision', true)],
    ]))
    const { ctx } = await mount({ fallback: vision }, adapter, ['text-route', 'vision-route'])

    await ask(ctx, 'cross-provider', text)
    expect(adapter.requests[0]).toMatchObject(vision)
  })

  it('prefers a declared vision model on the selected provider over a cross-provider fallback', async () => {
    const text = selection('text-route', 'text')
    const localVision = selection('text-route', 'local-vision')
    const fallback = selection('vision-route', 'fallback-vision')
    const adapter = new CatalogAdapter([
      catalog('text-route', 'local-vision', true),
    ], new Map([
      ['text-route/text', model('text-route', 'text', false)],
      ['text-route/local-vision', model('text-route', 'local-vision', true)],
      ['vision-route/fallback-vision', model('vision-route', 'fallback-vision', true)],
    ]))
    const { ctx } = await mount({ fallback }, adapter, ['text-route', 'vision-route'])

    await ask(ctx, 'same-provider-before-fallback', text)
    expect(adapter.requests[0]).toMatchObject(localVision)
  })

  it('rejects an explicit fallback that does not declare image input', async () => {
    const text = selection('route', 'text')
    const fallback = selection('route', 'fallback')
    const adapter = new CatalogAdapter([], new Map([
      ['route/text', model('route', 'text', false)],
      ['route/fallback', model('route', 'fallback', false)],
    ]))
    const { ctx } = await mount({ fallback }, adapter, ['route'])
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    await ask(ctx, 'invalid-fallback', text)
    expect(errors).toMatchObject([{ code: 'IMAGE_ROUTE_UNAVAILABLE' }])
    expect(adapter.requests).toHaveLength(0)
  })

  it('keeps the text route and its image projection when no declared vision model is available', async () => {
    const text = selection('route', 'text')
    const adapter = new CatalogAdapter([], new Map([
      ['route/text', model('route', 'text', false)],
    ]))
    const { ctx } = await mount({}, adapter, ['route'])

    await ask(ctx, 'no-vision', text)
    expect(adapter.requests[0]).toMatchObject(text)
    expect(adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(false)
  })

  it('stops routing when its plugin fiber is disposed', async () => {
    const text = selection('route', 'text')
    const adapter = new CatalogAdapter([
      catalog('route', 'vision', true),
    ], new Map([
      ['route/text', model('route', 'text', false)],
      ['route/vision', model('route', 'vision', true)],
    ]))
    const { ctx, policy } = await mount({}, adapter, ['route'])
    await policy.dispose()

    await ask(ctx, 'disposed-policy', text)
    expect(adapter.requests[0]).toMatchObject(text)
  })
})
