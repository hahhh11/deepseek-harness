/**
 * Configuration surface for the TencentDB Agent Memory bridge.
 *
 * The plugin never owns the memory engine: it speaks the gateway's HTTP
 * contract and optionally supervises the gateway child process. Every field
 * therefore names either a wire detail, an identity dimension, or a
 * lifecycle choice — nothing about memory structure itself.
 *
 * @module @deepseek-ai/dsh-memory-tdai/config
 */

import z from '@deepseek-ai/schemastery'

/** Pre-answer recall: which memories are injected and how large they may be. */
export interface RecallConfig {
  /** Inject recalled memories before the first step of a turn. */
  enabled: boolean
  /** Gateway round-trip budget in milliseconds; timeout skips injection. */
  timeoutMs: number
  /** Maximum characters of the composed injection; `0` disables the cap. */
  maxChars: number
  /** Hits requested per level. */
  limit: number
}

/** Post-turn capture: which turns are written back as L0 conversations. */
export interface CaptureConfig {
  /** Write completed turns back to L0. */
  enabled: boolean
  /** Minimum milliseconds between two writes from one session. */
  minIntervalMs: number
}

/** Model-facing memory search tools. */
export interface ToolsConfig {
  /** Register `memory_search` and `conversation_search`. */
  enabled: boolean
}

/** Gateway child-process supervision. */
export interface SidecarConfig {
  /** Spawn the gateway when the configured URL is not answering. */
  autoStart: boolean
  /** Shell command that runs the gateway; required when `autoStart` is true. */
  command?: string
  /** Directory for the child's stdout/stderr logs. */
  logDir?: string
  /** Milliseconds to wait for `/health` after spawning. */
  startupTimeoutMs: number
  /** Extra environment entries for the child, typically gateway LLM credentials. */
  env?: Record<string, string>
}

/** Complete plugin configuration. */
export interface Config {
  /** Mount the plugin's behaviour. Defaults to true once the row exists. */
  enabled?: boolean
  /** Gateway origin, for example `http://127.0.0.1:8420`. */
  baseUrl?: string
  /** Environment variable holding the gateway bearer token. */
  apiKeyEnv?: string
  /** `x-tdai-service-id` header value; the gateway's only tenant dimension. */
  serviceId?: string
  recall?: RecallConfig
  capture?: CaptureConfig
  tools?: ToolsConfig
  sidecar?: SidecarConfig
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('http://127.0.0.1:8420'),
  apiKeyEnv: z.string(),
  serviceId: z.string().default('default'),
  recall: z.object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().min(1).default(1500),
    maxChars: z.number().min(0).default(2000),
    limit: z.number().min(1).max(20).default(5),
  }),
  capture: z.object({
    enabled: z.boolean().default(true),
    minIntervalMs: z.number().min(0).default(0),
  }),
  tools: z.object({
    enabled: z.boolean().default(true),
  }),
  sidecar: z.object({
    autoStart: z.boolean().default(false),
    command: z.string(),
    logDir: z.string(),
    startupTimeoutMs: z.number().min(1).default(20000),
    env: z.dict(z.string()),
  }),
})

/** Normalized configuration with every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  baseUrl: string
  apiKeyEnv: string | undefined
  serviceId: string
  recall: { enabled: boolean; timeoutMs: number; maxChars: number; limit: number }
  capture: { enabled: boolean; minIntervalMs: number }
  tools: { enabled: boolean }
  sidecar: {
    autoStart: boolean
    command: string | undefined
    logDir: string | undefined
    startupTimeoutMs: number
    env: Record<string, string>
  }
}

/**
 * Apply defaults and strip the trailing slash so path joins stay unambiguous.
 * @param config - validated plugin configuration.
 * @returns the normalized configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const sidecar: Partial<SidecarConfig> = config.sidecar ?? {}
  if (sidecar.autoStart === true && (sidecar.command === undefined || sidecar.command.trim() === '')) {
    throw new Error('memory-tdai: sidecar.autoStart requires sidecar.command')
  }
  return {
    enabled: config.enabled ?? true,
    baseUrl: (config.baseUrl ?? 'http://127.0.0.1:8420').replace(/\/+$/, ''),
    apiKeyEnv: config.apiKeyEnv,
    serviceId: config.serviceId ?? 'default',
    recall: {
      enabled: config.recall?.enabled ?? true,
      timeoutMs: config.recall?.timeoutMs ?? 1500,
      maxChars: config.recall?.maxChars ?? 2000,
      limit: config.recall?.limit ?? 5,
    },
    capture: {
      enabled: config.capture?.enabled ?? true,
      minIntervalMs: config.capture?.minIntervalMs ?? 0,
    },
    tools: { enabled: config.tools?.enabled ?? true },
    sidecar: {
      autoStart: sidecar.autoStart ?? false,
      command: sidecar.command,
      logDir: sidecar.logDir,
      startupTimeoutMs: sidecar.startupTimeoutMs ?? 20000,
      env: { ...(sidecar.env ?? {}) },
    },
  }
}
