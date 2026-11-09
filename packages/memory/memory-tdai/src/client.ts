/**
 * Wire client for the TencentDB Agent Memory gateway (v2 REST surface).
 *
 * Deliberately small: the gateway owns extraction, layering, and storage; this
 * module owns exactly the four verbs the harness needs — health, L0 append,
 * L1 search, and L3 persona read — plus their envelope, auth, and timeout rules.
 *
 * The published gateway (1.0.3) mounts these under `/v2` and requires both an
 * `Authorization: Bearer <key>` header (any non-empty value in standalone mode)
 * and a non-empty `x-tdai-service-id`. Tenant isolation is the service id, not
 * per-request team/agent/user fields.
 *
 * @module @deepseek-ai/dsh-memory-tdai/client
 */

import type { ResolvedConfig } from './config.ts'

/** One recalled memory row as returned by the gateway's search verbs. */
export interface MemoryHit {
  /** Memory text. */
  content: string
  /** Relevance score assigned by the gateway's fusion step. */
  score?: number
  /** Memory class for L1 rows: episodic, persona, or instruction. */
  type?: string
  /** Message role for L0 hits. */
  role?: string
}

/** One L0 conversation message in the gateway's capture shape. */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  /** ISO-8601 timestamp; the gateway defaults to its receive time when omitted. */
  timestamp?: string
}

/** Envelope every v2 route answers with. */
interface Envelope<T> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}

/** A gateway answered with a non-success envelope or a transport failure. */
export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

/** Health verdict of the gateway process behind {@link MemoryGatewayClient}. */
export type HealthVerdict = 'ok' | 'degraded' | 'down'

/**
 * HTTP client for one gateway origin.
 *
 * Every method resolves rather than hanging: the harness must never stall a
 * turn on a memory sidecar, so timeouts surface as {@link GatewayError} and
 * callers degrade to "no memory" instead of propagating.
 */
export class MemoryGatewayClient {
  private readonly baseUrl: string
  private readonly serviceId: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(
    config: Pick<ResolvedConfig, 'baseUrl' | 'serviceId' | 'apiKeyEnv'>,
    apiKey?: string,
    timeoutMs = 1500,
  ) {
    this.baseUrl = config.baseUrl
    this.serviceId = config.serviceId
    // Standalone gateways accept any non-empty bearer; the header is still mandatory.
    this.apiKey = apiKey !== undefined && apiKey !== '' ? apiKey : 'dsh'
    this.timeoutMs = timeoutMs
  }

  /** Rebind the per-request budget; recall uses a tighter one than capture. */
  withTimeout(timeoutMs: number): MemoryGatewayClient {
    return new MemoryGatewayClient(
      { baseUrl: this.baseUrl, serviceId: this.serviceId, apiKeyEnv: undefined },
      this.apiKey,
      timeoutMs,
    )
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-tdai-service-id': this.serviceId,
      authorization: `Bearer ${this.apiKey}`,
    }
  }

  private async request<T>(path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T | undefined> {
    let response: Response
    const signal = AbortSignal.timeout(timeoutMs)
    const init: RequestInit = body === undefined
      ? { method: 'GET', headers: this.headers(), signal }
      : { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal }
    try {
      response = await fetch(`${this.baseUrl}${path}`, init)
    } catch (error) {
      throw new GatewayError(`memory gateway unreachable at ${this.baseUrl}${path}: ${(error as Error).message}`)
    }
    if (!response.ok) {
      throw new GatewayError(`memory gateway ${path} answered ${response.status}`, response.status)
    }
    const text = await response.text()
    if (text.trim() === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new GatewayError(`memory gateway ${path} returned non-JSON body`)
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as Envelope<T>
      if ('code' in envelope || 'data' in envelope) {
        if (envelope.code !== undefined && envelope.code !== 0) {
          throw new GatewayError(`memory gateway ${path} failed: ${envelope.message ?? `code ${envelope.code}`}`)
        }
        return envelope.data
      }
    }
    return parsed as T
  }

  /**
   * Probe the gateway.
   * @returns the health verdict, never throwing.
   */
  async health(): Promise<HealthVerdict> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (!response.ok) return 'down'
      const body = await response.json() as { status?: string }
      if (body.status === 'ok') return 'ok'
      if (body.status === 'degraded') return 'degraded'
      return 'down'
    } catch {
      return 'down'
    }
  }

  /**
   * Append one completed turn to L0.
   * @param messages - the turn's user and assistant text, oldest first.
   * @param sessionId - harness session id used as the gateway's conversation id.
   */
  async addConversation(messages: readonly ConversationMessage[], sessionId: string): Promise<void> {
    if (messages.length === 0) return
    await this.request('/v2/conversation/add', {
      session_id: sessionId,
      messages: messages.map(message => ({
        role: message.role,
        content: message.content,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      })),
    }, 5000)
  }

  /** Search structured L1 memories. */
  async searchMemories(query: string, limit: number): Promise<MemoryHit[]> {
    const data = await this.request<{ items?: MemoryHit[] }>('/v2/atomic/search', { query, limit })
    return data?.items ?? []
  }

  /** Search raw L0 conversations. */
  async searchConversations(query: string, limit: number): Promise<MemoryHit[]> {
    const data = await this.request<{ messages?: MemoryHit[] }>('/v2/conversation/search', { query, limit })
    return data?.messages ?? []
  }

  /**
   * Read the L3 persona document, which carries stable user preferences.
   * @returns the persona text, or an empty string when none has been built yet.
   */
  async readPersona(): Promise<string> {
    const data = await this.request<{ content?: string | null }>('/v2/core/read', {})
    return typeof data?.content === 'string' ? data.content : ''
  }
}
