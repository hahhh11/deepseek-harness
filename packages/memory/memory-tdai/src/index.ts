/**
 * TencentDB Agent Memory bridge for DeepSeek Harness.
 *
 * The harness keeps no long-term memory of its own; this plugin gives it one by
 * speaking the TencentDB Agent Memory gateway contract at two seams and one
 * surface:
 *
 * - `agent/pre-step` recalls L1 atoms and the L3 persona before the first step
 *   of a turn and appends them as one durable, source-attributed user message.
 * - `agent/turn-stopping` writes the completed exchange back as an L0
 *   conversation, which is what the gateway's L1 -> L2 -> L3 pipeline consumes.
 * - two model-facing tools search those layers on demand.
 *
 * Every call degrades: an unreachable gateway means "no memory this turn", not
 * a failed turn. The gateway itself is a child process this plugin may
 * supervise, mirroring the MCP stdio sidecar discipline.
 *
 * @module @deepseek-ai/dsh-memory-tdai
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-tdai': { kind: 'memory-tdai' } & ContextFormed
  }
}

import { Config, resolveConfig } from './config.ts'
import { MemoryGatewayClient, type ConversationMessage, type MemoryHit } from './client.ts'
import { GatewaySidecar, sidecarOptions } from './sidecar.ts'

export { Config, resolveConfig }
export type { Config as MemoryTdaiConfig, ResolvedConfig } from './config.ts'
export { MemoryGatewayClient, GatewayError } from './client.ts'
export type { MemoryHit, ConversationMessage, HealthVerdict } from './client.ts'
export { GatewaySidecar, sidecarOptions } from './sidecar.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-tdai'

/** Registries this plugin writes through. */
export const inject = ['agents', 'tools']

/** Text of one content block list, ignoring non-text blocks. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

/** Render recalled rows into one bounded block. */
function renderMemories(persona: string, hits: readonly MemoryHit[], maxChars: number): string {
  const sections: string[] = []
  if (persona.trim() !== '') sections.push(`User persona:\n${persona.trim()}`)
  const rows = hits
    .map(hit => hit.content.trim())
    .filter(content => content !== '')
  if (rows.length > 0) {
    sections.push(`Recalled memories:\n${rows.map(row => `- ${row}`).join('\n')}`)
  }
  const text = sections.join('\n\n')
  return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** Collect the turn's user and assistant text from the session surface. */
function turnMessages(agent: Agent, turn: number): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  for (const seq of agent.session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- existing surface read path
    const event = agent.session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: string } | undefined
      // Only direct human input belongs in memory: injected context (clocks,
      // workspace instructions, earlier recall) would otherwise be captured as
      // if the user had typed it.
      if (source?.kind !== 'user') continue
      const text = blocksToText(event.data.content)
      if (text !== '') messages.push({ role: 'user', content: text, timestamp: new Date(event.time).toISOString() })
      continue
    }
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = blocksToText(event.data.message.content)
      if (text !== '') messages.push({ role: 'assistant', content: text, timestamp: new Date(event.time).toISOString() })
    }
  }
  return messages
}

/**
 * Mount recall, capture, and search over one gateway.
 * @param ctx - registrant context carrying the agent and tool registries.
 * @param config - deployment's gateway location, identity, and lifecycle choices.
 * @returns when every registration is installed.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const apiKey = resolved.apiKeyEnv === undefined ? undefined : process.env[resolved.apiKeyEnv]
  const client = new MemoryGatewayClient(resolved, apiKey)
  const sidecarOptionsValue = sidecarOptions(resolved.sidecar)
  const sidecar = sidecarOptionsValue === undefined ? undefined : new GatewaySidecar(sidecarOptionsValue)
  if (sidecar !== undefined) {
    ctx.effect(function* () {
      yield async () => { await sidecar.stop() }
    }, 'memory-tdai sidecar')
    void sidecar.ensureRunning(client).catch((error: unknown) => {
      ctx.logger.warn(`memory-tdai: gateway supervision failed: ${(error as Error).message}`)
    })
  }

  ctx.logger.info(
    `memory-tdai: gateway ${resolved.baseUrl} (recall=${resolved.recall.enabled ? `on/${resolved.recall.timeoutMs}ms` : 'off'}, `
    + `capture=${resolved.capture.enabled ? 'on' : 'off'}, tools=${resolved.tools.enabled ? 'on' : 'off'})`,
  )

  const recalledTurns = new WeakMap<object, number>()
  const lastCapture = new WeakMap<object, number>()

  if (resolved.recall.enabled) {
    ctx.on('agent/pre-step', async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (step !== 1 || recalledTurns.get(agent.session) === turn) return decision
      const prompt = lastUserText(decision.messages)
      if (prompt === undefined) return decision
      recalledTurns.set(agent.session, turn)
      let text: string
      try {
        const [persona, hits] = await Promise.all([
          client.readPersona(),
          client.searchMemories(prompt, resolved.recall.limit),
        ])
        text = renderMemories(persona, hits, resolved.recall.maxChars)
      } catch {
        return decision
      }
      if (text === '') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: `Background memory for this conversation:\n\n${text}` }],
            source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      }
    })
  }

  if (resolved.capture.enabled) {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
      if (signal.aborted) return
      const now = Date.now()
      const previous = lastCapture.get(agent.session)
      if (previous !== undefined && now - previous < resolved.capture.minIntervalMs) return
      lastCapture.set(agent.session, now)
      const messages = turnMessages(agent, turn)
      if (messages.length === 0) return
      try {
        await client.addConversation(messages, agent.session.id)
      } catch (error) {
        ctx.logger.warn(`memory-tdai: capture skipped: ${(error as Error).message}`)
      }
    })
  }

  if (resolved.tools.enabled) {
    ctx.tools.register(defineTool({
      name: 'memory_search',
      description:
        'Search long-term memories extracted from earlier conversations (preferences, decisions, '
        + 'project facts). Use it when the user refers to something discussed before. '
        + 'Conversation transcripts are available through conversation_search.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return (1-20, default 5).',
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const limit = Math.min(20, Math.max(1, args.limit ?? 5))
        const hits = await client.searchMemories(args.query, limit)
        if (hits.length === 0) return 'No matching memory.'
        return hits
          .map((hit, index) => `${index + 1}. ${hit.content}${hit.type === undefined ? '' : ` (${hit.type})`}`)
          .join('\n')
      },
      presentCall: args => ({ card: 'generic', title: 'Search memory', kind: 'search', rawInput: args.query }),
    }))

    ctx.tools.register(defineTool({
      name: 'conversation_search',
      description:
        'Search raw transcripts of earlier conversations, older than what this session contains. '
        + 'Prefer memory_search for distilled facts; use this for exact wording or chronology.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
        limit: {
          type: 'integer',
          description: 'Maximum rows to return (1-20, default 5).',
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const limit = Math.min(20, Math.max(1, args.limit ?? 5))
        const hits = await client.searchConversations(args.query, limit)
        if (hits.length === 0) return 'No matching conversation.'
        return hits.map((hit, index) => `${index + 1}. ${hit.content}`).join('\n')
      },
      presentCall: args => ({ card: 'generic', title: 'Search conversations', kind: 'search', rawInput: args.query }),
    }))
  }

}

/** Last non-injected user text in the messages about to be sent. */
function lastUserText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown; source?: { kind?: string } }
    if (message.role !== 'user') continue
    const sourceKind = message.source?.kind
    if (sourceKind !== undefined && sourceKind !== 'user') continue
    const text = blocksToText(message.content)
    if (text !== '') return text
  }
  return undefined
}
