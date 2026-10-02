/** Stock-release compatibility: native MCP works; unsupported TypeScript mode fails explicitly. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Provider from '../src/index.ts'

it('distinguishes manifest-based defaults from an explicitly empty argument list', () => {
  expect(Provider.Config({}).args).toBeUndefined()
  expect(Provider.Config({ args: [] }).args).toEqual([])
})

it.each(['source', 'built'] as const)('loads the %s plugin on stock Harness and rejects unavailable TypeScript support', async (kind) => {
  const plugin: typeof Provider = kind === 'source' ? Provider : await import(new URL('../dist/index.js', import.meta.url).href)
  const root = await mkdtemp(join(tmpdir(), 'standalone-cua-'))
  const ctx = new Context()
  try {
    await ctx.plugin(ComputerUse)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const unsupported = ctx.plugin(plugin, { mode: 'typescript' })
    await expect(unsupported.await()).rejects.toThrow('integration patch')
    await unsupported.dispose()
    const provider = await ctx.plugin(plugin, { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url)), root], reconnect: { enabled: false } })
    const result = await ctx.tools.execute({ name: 'mcp__cua-driver__screenshot', arguments: { display: 0 }, callId: ToolCallId('stock'), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Display 0' })
    await provider.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
