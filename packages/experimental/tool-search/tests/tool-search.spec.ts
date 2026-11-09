import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as ToolSearch from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Register one trivial tool under `name`. */
function fakeTool(ctx: Context, name: string, description: string): void {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return `${name} ran`
    },
  }))
}

/** Mount prerequisites, the plugin, three MCP tools, one native tool, and one agent. */
async function mountFixture(config: ToolSearch.Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ToolSearch, config)
  fakeTool(ctx, 'mcp__github__create_issue', 'Create an issue in a GitHub repository.')
  fakeTool(ctx, 'mcp__github__list_pull_requests', 'List pull requests for a repository.')
  fakeTool(ctx, 'mcp__slack__post_message', 'Post a message to a Slack channel.')
  fakeTool(ctx, 'read_file', 'Read a file from disk.')
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('tool-search-test'))
  return { ctx, agent }
}

describe('deferred tool schemas', () => {
  it('hides MCP schemas per agent while keeping the catalog and the loader visible', async () => {
    const { ctx, agent } = await mountFixture()

    const visible = ctx.tools.schemas(agent).map(schema => schema.name).sort()
    expect(visible).toEqual(['read_file', 'tool_search'])
    // The restriction is agent-scoped: the global view still knows every tool.
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('mcp__github__create_issue')

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))
    expect(prompt).toContain('## Deferred tools')
    expect(prompt).toContain('These 3 tool schemas')
    expect(prompt).toContain('mcp__github__create_issue')
    expect(prompt).toContain('tool_search')
  })

  it('loads a matched schema for the next step', async () => {
    const { ctx, agent } = await mountFixture()

    const result = await executeModelToolFixture(ctx, {
      callId: ToolCallId('call-1'),
      name: 'tool_search',
      arguments: { query: 'create github issue' },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('mcp__github__create_issue')

    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('mcp__github__create_issue')
    expect(visible).not.toContain('mcp__slack__post_message')

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))
    expect(prompt).not.toContain('- mcp__github__create_issue')
    expect(prompt).toContain('mcp__slack__post_message')
  })

  it('loads exact names and reports the ones that were never deferred', async () => {
    const { ctx, agent } = await mountFixture()
    const result = await executeModelToolFixture(ctx, {
      callId: ToolCallId('call-2'),
      name: 'tool_search',
      arguments: { names: ['mcp__slack__post_message', 'read_file', 'mcp__nope__x'] },
      agent,
      signal: new AbortController().signal,
    })
    const text = JSON.stringify(result.content)
    expect(text).toContain('mcp__slack__post_message')
    expect(text).toContain('read_file')
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toContain('mcp__slack__post_message')
  })

  it('defers explicit names and lets eager patterns win', async () => {
    const { ctx, agent } = await mountFixture({
      mcp: false,
      defer: ['read_*'],
      eager: ['read_file'],
    })
    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('read_file')
    expect(visible).toContain('mcp__github__create_issue')
    expect(visible).toEqual(expect.arrayContaining(['tool_search']))
  })

  it('defers by prefix pattern when configured', async () => {
    const { ctx, agent } = await mountFixture({ mcp: false, defer: ['mcp__github__*'] })
    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible).not.toContain('mcp__github__create_issue')
    expect(visible).toContain('mcp__slack__post_message')
  })

  it('keeps every tool visible for a second agent with no deferral match', async () => {
    const { ctx, agent } = await mountFixture()
    const second = await ctx.agentLoop.create(SessionId('tool-search-second'))
    // Two agents share the same deferral policy but keep independent loaded sets.
    await executeModelToolFixture(ctx, {
      callId: ToolCallId('call-3'),
      name: 'tool_search',
      arguments: { names: ['mcp__slack__post_message'] },
      agent: second,
      signal: new AbortController().signal,
    })
    expect(ctx.tools.schemas(second).map(schema => schema.name)).toContain('mcp__slack__post_message')
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).not.toContain('mcp__slack__post_message')
  })
})
