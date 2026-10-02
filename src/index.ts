/** Opt-in Cua Driver installation and computer-use tools with live TypeScript-only exposure. @module */

import { isAbsolute } from 'node:path'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { DriverInstallation, type InstallationConfig } from './installation.ts'

/** Cordis identity of the managed local provider. */
export const name = 'cua-driver'

/** Both exposure modes use the tool executor and exclusive computer-use registration. */
export const inject = ['computerUse', 'tools']

/** Driver installation settings and live model exposure. */
export interface Config extends InstallationConfig {
  /** Native MCP tools or TypeScript functions available only through run_code. */
  mode: Volatile<'tools' | 'typescript'>
  /** Complete installation/update/manifest deadline; MCP startup follows the shared client policy. */
  setupTimeoutMs: number
  /** Per-call MCP timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Shared MCP reconnection policy overrides. */
  reconnect: McpClient.ReconnectConfig
}

/** Validate profile settings; mode edits apply without restarting the driver. */
export const Config = z.object({
  mode: z.union(['tools', 'typescript'] as const).default('tools').volatile(),
  command: z.string().pattern(/[^\s]/u).default('cua-driver'),
  binDir: z.string().pattern(/[^\s]/u),
  args: z.union([z.array(String), z.const(undefined)]).default(undefined),
  autoInstall: z.boolean().default(false),
  autoUpdate: z.boolean().default(false),
  updateChannel: z.union(['stable', 'nightly'] as const).default('stable'),
  setupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  toolCallTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  maxInstallerBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_048_576),
  maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(131_072),
  terminationGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(1_000),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
    maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
    maxAttempts: z.number().step(1).min(1),
  }),
})

/** A stock Harness must not silently expose native tools for a TypeScript-only request. */
function requireProgrammaticSupport(ctx: Context): void {
  if (Reflect.get(ctx.tools, 'supportsProgrammaticOnly') !== true || Reflect.get(McpClient, 'supportsProgrammaticOnly') !== true) {
    throw new Error('Cua Driver TypeScript mode requires the Harness programmatic-only integration patch; see the plugin README')
  }
}

/** Require TypeScript when projecting or dispatching a programmatic-only capability. */
function programmaticOnly(ctx: Context, config: Config): boolean {
  if (config.mode.get() === 'tools') return false
  requireProgrammaticSupport(ctx)
  if (ctx.get('ptcRuntime')?.language !== 'typescript') {
    throw new Error('Cua Driver mode "typescript" requires a TypeScript PTC runtime, such as @deepseek-ai/dsh-ptc-runtime-node')
  }
  return true
}

/**
 * Reserve local computer use through setup, MCP reconnects, and final child teardown.
 * Installation/update are opt-in; changing mode never replaces the active driver.
 * @param ctx - context providing computer use and the tool registry.
 * @param config - validated deployment choices and live exposure reference.
 * @returns after executable setup and the first MCP catalog have completed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.binDir !== undefined && !isAbsolute(config.binDir)) throw new Error('Cua Driver binDir must be absolute')
  if (config.mode.get() === 'typescript') requireProgrammaticSupport(ctx)
  ctx.on('system-prompt/assemble', (_assembly, _context, next) => {
    programmaticOnly(ctx, config)
    return next()
  })
  let child!: Fiber
  const lifetime = new AbortController()
  // The parent may still be awaiting setup, so it must cancel the child before awaiting its apply().
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the ordered effect joins the same disposer.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    lifetime.abort(new Error('Cua Driver provider unloaded'))
    return child?.dispose()
  }, { global: true })
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver'))
    child = ctx.plugin({
      name: 'cua-driver-connection',
      inject,
      async apply(inner: Context) {
        try {
          inner.on('internal/plugin', (fiber) => {
            if (fiber === inner.fiber && fiber.uid === null) lifetime.abort(new Error('Cua Driver provider unloaded'))
          }, { global: true })
          // Installation must run locally even when the application's subprocess provider is remote.
          const local = inner.isolate('subprocess')
          const subprocess = local.plugin(LocalSubprocess)
          await subprocess.await()
          const deadline = AbortSignal.timeout(config.setupTimeoutMs)
          const signal = AbortSignal.any([lifetime.signal, deadline])
          let invocation: Awaited<ReturnType<DriverInstallation['resolve']>>
          try {
            const runtime = local.get('subprocess')
            if (runtime === undefined) throw new Error('Cua Driver local subprocess provider did not activate')
            invocation = await new DriverInstallation(runtime, config, signal).resolve()
          } finally {
            await subprocess.dispose()
          }
          lifetime.signal.throwIfAborted()
          const connection = McpClient.Config({
            transport: 'stdio', serverName: 'cua-driver',
            ...invocation, toolCallTimeoutMs: config.toolCallTimeoutMs,
            failOnStartupError: true, reconnect: config.reconnect,
          })
          const managedConnection = {
            ...connection,
            get programmaticOnly() { return programmaticOnly(inner, config) },
          }
          await McpClient.apply(inner, managedConnection)
        } catch (error) {
          if (!lifetime.signal.aborted) throw error
        }
      },
    })
    yield child.dispose
  }, 'computer-use-cua-driver.connection')
  await child.await()
}
