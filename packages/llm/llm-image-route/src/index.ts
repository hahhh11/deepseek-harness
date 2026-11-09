/**
 * Route current image questions to a model that declares image input.
 * @module @deepseek-ai/dsh-llm-image-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { z } from 'zod'

export const name = 'llm-image-route'
export const inject = ['agents', 'llm']

/** Explicit route used when the selected provider advertises no image-capable model. */
export interface ImageRouteFallback {
  /** Provider route; omitted reuses the selected provider. */
  readonly provider?: string
  /** Model that must declare image input. */
  readonly model: string
  /** Optional effort for this one routed request. */
  readonly reasoningEffort?: string
}

/** Image-routing policy configuration. */
export interface Config {
  /** Explicit route used when the selected provider has no declared image-capable model. */
  readonly fallback?: ImageRouteFallback
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  fallback: z.object({
    provider: z.string().min(1).exactOptional(),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).exactOptional(),
  }).exactOptional(),
}).default({})

function supportsImage(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities?.includes('image') === true
}

function fallbackSelection(config: Config, selected: Readonly<ModelSelection>): ModelSelection | undefined {
  const fallback = config.fallback
  if (fallback === undefined) return undefined
  const provider = fallback.provider ?? selected.provider
  return {
    provider,
    model: fallback.model,
    ...fallback.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(fallback.reasoningEffort) },
  }
}

async function resolveImageRoute(
  ctx: Context,
  config: Config,
  selected: Readonly<ModelSelection>,
  signal: AbortSignal,
): Promise<Readonly<ModelSelection>> {
  const current = await ctx.llm.resolveModelInfo(selected.provider, selected.model, signal)
  if (supportsImage(current.inputModalities)) return selected

  for (const candidate of await ctx.llm.listModels(selected.provider)) {
    if (!supportsImage(candidate.inputModalities)) continue
    const routed = { provider: selected.provider, model: candidate.id }
    const resolved = await ctx.llm.resolveModelInfo(routed.provider, routed.model, signal)
    if (supportsImage(resolved.inputModalities)) return routed
  }

  const explicit = fallbackSelection(config, selected)
  if (explicit === undefined) return selected
  const resolved = await ctx.llm.resolveModelInfo(explicit.provider, explicit.model, signal)
  if (supportsImage(resolved.inputModalities)) return explicit
  throw new LlmError(
    `image route fallback "${explicit.provider}/${explicit.model}" does not declare image input`,
    'IMAGE_ROUTE_UNAVAILABLE',
  )
}

/**
 * Install the image-input route policy. The selected model remains the
 * Session's next choice; request headers record the model this step used.
 * @param ctx - context providing the Agent and LLM services.
 * @param config - optional explicit cross-provider fallback.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.on('agent/resolve-model', async ({ messages, signal }, next) => {
    const selected = await next()
    if (signal.aborted || !messages.some(message => contentHasImage(message.content))) return selected
    return resolveImageRoute(ctx, config, selected, signal)
  })
}
