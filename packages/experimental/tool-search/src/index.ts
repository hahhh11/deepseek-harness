/**
 * Deferred tool schemas plus a model-facing `tool_search` loader.
 *
 * The registry feeds every registered tool's schema into prompt assembly. With
 * many MCP servers mounted that schema block dominates the request while most
 * tools never see a call. This plugin hides the configured subset behind a
 * per-agent restriction and keeps a names-only catalog in the system prompt, so
 * the model still knows what exists and loads the schema it needs on demand.
 *
 * @module @deepseek-ai/dsh-tool-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'tool-search'
export const inject = ['tools', 'systemPrompt']

/** Model-facing loader tool name; never deferred. */
const TOOL_NAME = 'tool_search'
/** Namespace every MCP tool shares (`mcp__<server>__<tool>`). */
const MCP_PREFIX = 'mcp__'
/** Catalog description budget per deferred tool. */
const CATALOG_DESCRIPTION_LIMIT = 80
/** Catalog entries rendered before the list is summarized. */
const DEFAULT_CATALOG_MAX = 60
const NO_MATCH = 'No deferred tool matched that query.'

/** Configuration for the deferred-schema loader. */
export interface Config {
  /** Tool names or `prefix*` patterns whose schemas stay hidden until loaded. */
  defer?: string[]
  /** Patterns that always keep a schema visible, even when `defer` or `mcp` selects it. */
  eager?: string[]
  /** Hide every `mcp__<server>__<tool>` schema by default. */
  mcp?: boolean
  /** Results `tool_search` loads when the model does not pass `limit`. */
  limit?: number
  /** Most results one `tool_search` call may load. */
  maxResults?: number
  /** Keep a names-only catalog of hidden tools in the system prompt. */
  catalog?: boolean
  /** Catalog entries rendered before the tail is summarized by name only. */
  catalogMax?: number
  /** Section order for the catalog; sections concatenate in ascending order. */
  sectionOrder?: number
}

/** Validate and default the deferred-schema configuration. */
export const Config: z<Config> = z.object({
  defer: z.array(z.string()).default([]),
  eager: z.array(z.string()).default([]),
  mcp: z.boolean().default(true),
  limit: z.number().default(5),
  maxResults: z.number().default(10),
  catalog: z.boolean().default(true),
  catalogMax: z.number().default(DEFAULT_CATALOG_MAX),
  sectionOrder: z.number().default(640),
})

/** One agent's live deferral state. */
interface AgentState {
  /** Scoped context that owns the restriction, keyed by the agent. */
  readonly scope: ReturnType<typeof createScope>
  /** Names this agent currently defers, recomputed whenever tools change. */
  deferred: Set<string>
  /** Names the model has already loaded for this agent. */
  loaded: Set<string>
  /** Names the active restriction denies. */
  denied: Set<string>
  /** Disposer for the active restriction, when one is applied. */
  release: (() => void) | undefined
}

/** Match one name against an exact entry or a `prefix*` pattern. */
function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim()
    if (trimmed === '') return false
    return trimmed.endsWith('*') ? name.startsWith(trimmed.slice(0, -1)) : name === trimmed
  })
}

/** Whether this tool's schema should wait behind the loader. */
function shouldDefer(toolName: string, config: Required<Config>): boolean {
  if (toolName === TOOL_NAME) return false
  if (matches(toolName, config.eager)) return false
  if (matches(toolName, config.defer)) return true
  return config.mcp && toolName.startsWith(MCP_PREFIX)
}

/** Split a query into comparison tokens: Latin words and single CJK characters. */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/[A-Za-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const token = match[0]
    if (/^[\u3400-\u4dbf\u4e00-\u9fff]/.test(token)) {
      for (const character of token) out.push(character)
    } else if (token.length >= 2) {
      out.push(token.toLowerCase())
    }
  }
  return out
}

/** Clip one description for the catalog and for a loader reply. */
function clip(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`
}

/** Score one deferred tool against a query; higher is a better match. */
function score(query: string, tokens: readonly string[], tool: ToolDefinition): number {
  const name = tool.name.toLowerCase()
  const description = tool.description.toLowerCase()
  const haystack = `${name} ${description}`
  let total = 0
  const lowered = query.toLowerCase().trim()
  if (lowered !== '' && name === lowered) total += 100
  else if (lowered !== '' && name.includes(lowered)) total += 40
  for (const token of tokens) {
    if (name.includes(token)) total += 10
    else if (haystack.includes(token)) total += 3
  }
  return total
}

/**
 * Defer the configured tool schemas per agent and expose `tool_search`.
 * @param ctx - context supplying the tool registry and system prompt.
 * @param config - deferral patterns, limits, and catalog settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    defer: config.defer ?? [],
    eager: config.eager ?? [],
    mcp: config.mcp ?? true,
    limit: config.limit ?? 5,
    maxResults: config.maxResults ?? 10,
    catalog: config.catalog ?? true,
    catalogMax: config.catalogMax ?? DEFAULT_CATALOG_MAX,
    sectionOrder: config.sectionOrder ?? 640,
  }
  if (resolved.limit < 1) throw new Error('tool-search: limit must be at least 1')
  if (resolved.maxResults < 1) throw new Error('tool-search: maxResults must be at least 1')
  if (resolved.catalogMax < 1) throw new Error('tool-search: catalogMax must be at least 1')

  const states = new Map<ScopeKey, AgentState>()
  let refreshing = false

  /** Recompute the deferred set from the current global registry view. */
  const refresh = (state: AgentState): void => {
    const next = new Set<string>()
    for (const definition of ctx.tools.definitions()) {
      if (shouldDefer(definition.name, resolved)) next.add(definition.name)
    }
    state.deferred = next
  }

  /** Push the current deny set onto the agent's scoped restriction. */
  const applyDeny = (state: AgentState): void => {
    const denied = new Set([...state.deferred].filter(toolName => !state.loaded.has(toolName)))
    if (denied.size === state.denied.size && [...denied].every(toolName => state.denied.has(toolName))) return
    state.release?.()
    state.release = undefined
    state.denied = denied
    if (denied.size === 0) return
    try {
      state.release = state.scope.ctx.tools.restrict({ deny: [...denied] })
    } catch (error: unknown) {
      // A registration that disappeared between the view and the restriction
      // leaves the catalog wider than intended for one step. Showing a schema
      // is recoverable; failing step preparation is not.
      state.denied = new Set()
      void error
    }
  }

  /** Read or create one agent's deferral state. */
  const stateOf = (agent: Agent): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: AgentState = {
      scope: createScope(ctx, agent),
      deferred: new Set(),
      loaded: new Set(),
      denied: new Set(),
      release: undefined,
    }
    states.set(agent, state)
    refresh(state)
    applyDeny(state)
    return state
  }

  const searchTool = defineTool({
    name: TOOL_NAME,
    description: [
      'Load the schema of tools whose definitions were withheld to keep this request small.',
      'Call it with keywords, or with exact names from the deferred-tools catalog in the system prompt.',
      'A loaded tool becomes callable on the NEXT step, not in the same batch as this call.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Keywords matched against deferred tool names and descriptions.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact tool names from the deferred-tools catalog, loaded without matching.',
      },
      limit: {
        type: 'number',
        description: 'How many matches to load for this query. Defaults to the configured limit.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          remaining: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'number', required: true },
          unmatched: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('tool_search needs the calling agent: it loads schemas for one agent scope')
      }
      const state = stateOf(agent)
      const requested = Math.min(args.limit ?? resolved.limit, resolved.maxResults)
      const loadedNames: string[] = []
      const unmatched: string[] = []

      if (args.names !== undefined && args.names.length > 0) {
        for (const raw of args.names) {
          const toolName = raw.trim()
          if (toolName === '' || loadedNames.length >= resolved.maxResults) continue
          if (state.deferred.has(toolName)) loadedNames.push(toolName)
          else unmatched.push(toolName)
        }
      } else if (args.query !== undefined && args.query.trim() !== '') {
        const query = args.query.trim()
        const tokens = tokenize(query)
        const ranked = [...state.deferred]
          .filter(toolName => !state.loaded.has(toolName))
          .map((toolName) => {
            const definition = ctx.tools.get(toolName)
            return definition === undefined
              ? undefined
              : { name: toolName, rank: score(query, tokens, definition) }
          })
          .filter((entry): entry is { name: string; rank: number } => entry !== undefined)
          .filter(entry => entry.rank > 0)
          .sort((left, right) => right.rank - left.rank || left.name.localeCompare(right.name))
        for (const entry of ranked.slice(0, requested)) loadedNames.push(entry.name)
      }

      for (const toolName of loadedNames) state.loaded.add(toolName)
      if (loadedNames.length > 0) applyDeny(state)

      const loaded = loadedNames.map(toolName => ({
        name: toolName,
        description: clip(ctx.tools.get(toolName)?.description ?? '', CATALOG_DESCRIPTION_LIMIT),
      }))
      const remaining = [...state.deferred]
        .filter(toolName => !state.loaded.has(toolName))
        .sort()
      return Promise.resolve({
        loaded,
        remaining,
        total: state.deferred.size,
        ...unmatched.length > 0 ? { unmatched } : {},
      })
    },
    presentCall(args) {
      const label = args.query ?? args.names?.join(', ') ?? ''
      return { card: 'generic', title: 'Search deferred tools', kind: 'read', rawInput: label }
    },
  })
  ctx.tools.register(searchTool)

  if (resolved.catalog) {
    ctx.systemPrompt.section({
      name: TOOL_NAME,
      order: resolved.sectionOrder,
      interpolate: false,
      text: ({ scope }) => {
        const state = scope === undefined ? undefined : states.get(scope)
        if (state === undefined) return ''
        const pending = [...state.deferred].filter(toolName => !state.loaded.has(toolName)).sort()
        return renderCatalog(pending, state.deferred.size, resolved.catalogMax)
      },
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    stateOf(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    state.release?.()
    void state.scope.dispose()
  })

  // A tool registered after this agent existed (an MCP server connecting late)
  // joins the deferred set on the next assembly. Restrictions emit this event,
  // so re-entry is blocked while masks are being refreshed.
  ctx.on('tools/change', () => {
    if (refreshing) return
    refreshing = true
    try {
      for (const state of states.values()) {
        refresh(state)
        applyDeny(state)
      }
    } finally {
      refreshing = false
    }
  })
}

/** Canonical `tool_search` value. */
interface SearchResult {
  loaded: { name: string; description: string }[]
  remaining: string[]
  total: number
  unmatched?: string[]
}

/** Model-facing text for one loader reply. */
function renderSearchResult(value: SearchResult): string {
  const unmatched = value.unmatched !== undefined && value.unmatched.length > 0
    ? `Not loaded (already visible, unknown, or loaded earlier): ${value.unmatched.join(', ')}.`
    : ''
  if (value.loaded.length === 0) {
    return [
      value.total === 0
        ? 'No tool schemas are deferred in this session; every registered tool is already visible.'
        : `${NO_MATCH} Deferred tools: ${value.remaining.join(', ')}.`,
      unmatched,
      value.total === 0 ? '' : 'Call tool_search with exact names from that list to load one.',
    ].filter(line => line !== '').join('\n')
  }
  return [
    `Loaded ${value.loaded.length} tool schema${value.loaded.length === 1 ? '' : 's'} for the next step:`,
    ...value.loaded.map(item => (item.description === '' ? `- ${item.name}` : `- ${item.name}: ${item.description}`)),
    '',
    'These tools are callable on your NEXT step, not in the batch that called tool_search.',
    value.remaining.length === 0
      ? 'Every deferred tool is now loaded.'
      : `Still deferred (${value.remaining.length}): ${value.remaining.join(', ')}.`,
    unmatched,
  ].filter(line => line !== '').join('\n')
}

/** System-prompt catalog of deferred-but-unloaded tools. */
function renderCatalog(pending: readonly string[], total: number, catalogMax: number): string {
  if (pending.length === 0) return ''
  const shown = pending.slice(0, catalogMax)
  const hidden = pending.length - shown.length
  return [
    '## Deferred tools',
    `These ${total} tool schemas are installed but withheld from this request to keep it small.`,
    'Their names are listed so you know they exist; call `tool_search` with keywords or exact names to load schemas. A loaded tool becomes callable on the next step.',
    '',
    ...shown.map(toolName => `- ${toolName}`),
    ...hidden > 0 ? [`- …and ${hidden} more (use tool_search to search the full set)`] : [],
  ].join('\n')
}
