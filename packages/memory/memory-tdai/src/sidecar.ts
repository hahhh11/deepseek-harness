/**
 * Supervises the memory gateway child process.
 *
 * Mirrors the stdio-sidecar discipline the MCP client already established:
 * probe first, spawn only when asked, keep the child's pipes drained into a
 * log file, and never let a dead child abort the session.
 *
 * @module @deepseek-ai/dsh-memory-tdai/sidecar
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ResolvedConfig } from './config.ts'
import type { MemoryGatewayClient } from './client.ts'

/** Resolved sidecar options after defaults. */
export interface SidecarOptions {
  command: string
  logDir: string
  startupTimeoutMs: number
  env: Record<string, string>
}

/**
 * Resolve the sidecar options of one activation.
 * @param sidecar - normalized plugin configuration slice.
 * @returns the options to spawn with.
 */
export function sidecarOptions(sidecar: ResolvedConfig['sidecar']): SidecarOptions | undefined {
  if (!sidecar.autoStart || sidecar.command === undefined) return undefined
  return {
    command: sidecar.command,
    logDir: sidecar.logDir ?? join(homedir(), '.dsh', 'logs', 'memory-tdai'),
    startupTimeoutMs: sidecar.startupTimeoutMs,
    env: sidecar.env,
  }
}

/** One supervised gateway child. */
export class GatewaySidecar {
  private child: ChildProcess | undefined
  private stdout: WriteStream | undefined
  private stderr: WriteStream | undefined
  private stopped = false

  constructor(private readonly options: SidecarOptions) {}

  /** Whether this supervisor currently owns a live child. */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * Start the gateway unless something already answers on its URL.
   * @param client - the same origin's client, used for health probes.
   * @returns true when a healthy gateway is reachable afterwards.
   */
  async ensureRunning(client: MemoryGatewayClient): Promise<boolean> {
    if ((await client.health()) !== 'down') return true
    if (this.stopped) return false
    if (this.running) return this.waitForHealth(client)

    mkdirSync(this.options.logDir, { recursive: true })
    this.stdout = createWriteStream(join(this.options.logDir, 'gateway.stdout.log'), { flags: 'a' })
    this.stderr = createWriteStream(join(this.options.logDir, 'gateway.stderr.log'), { flags: 'a' })
    try {
      this.child = spawn(this.options.command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
      })
    } catch (error) {
      this.closeLogs()
      throw new Error(`memory-tdai: failed to spawn gateway: ${(error as Error).message}`)
    }
    this.child.stdout?.pipe(this.stdout)
    this.child.stderr?.pipe(this.stderr)
    this.child.on('exit', () => { this.closeLogs() })
    return this.waitForHealth(client)
  }

  private async waitForHealth(client: MemoryGatewayClient): Promise<boolean> {
    const deadline = Date.now() + this.options.startupTimeoutMs
    while (Date.now() < deadline) {
      if ((await client.health()) !== 'down') return true
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }

  private closeLogs(): void {
    this.stdout?.end()
    this.stderr?.end()
    this.stdout = undefined
    this.stderr = undefined
  }

  /** Terminate the child this supervisor owns, if any. */
  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.closeLogs()
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
    this.child = undefined
    this.closeLogs()
  }
}
