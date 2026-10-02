/** Loader, real stdio MCP, and Node PTC composition with a scripted external model. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Provider from '../src/index.ts'

const TOOL = 'mcp__cua-driver__screenshot'
const fixture = fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url))
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class ScreenshotModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly mode: 'tools' | 'typescript') { super() }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as ('text' | 'image')[] }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const name = this.mode === 'tools' ? TOOL : 'run_code'
      const args = JSON.stringify(this.mode === 'tools' ? { display: 0 } : { code: `return (await tools[${JSON.stringify(TOOL)}]({display: 0})).structuredContent`, description: 'Inspect the selected computer display' })
      const id = ToolCallId('screenshot-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Display inspected.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function load(mode: 'tools' | 'typescript', failure = false, runtime = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-composition-'))
  roots.push(root)
  const model = new ScreenshotModel(mode)
  const ctx = new Context()
  contexts.push(ctx)
  const errors: unknown[] = []
  ctx.logger.exporter({ export(message) { if (message.type === 'error') message.args.forEach((argument: unknown) => errors.push(argument)) } })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, computer: ComputerUse, prompt: SystemPrompt, tools: ToolRuntime,
    llm: LlmRuntime, sessions: SessionStore, agents: AgentRegistry, loop: AgentLoop,
    projections: SessionProjectionRegistry, attachments: LocalAttachmentStore,
    fs: FileSystem, subprocess: Subprocess, sandbox: Sandbox, policy: SandboxPolicy, runtime: NodeRuntime,
    model: { inject: ['llm'], apply(inner: Context) { inner.effect(() => inner.llm.registerAdapter(['fixture'], model)) } },
    cua: Provider,
  })
  const config = { command: process.execPath, args: [fixture, root, ...(failure ? ['fail'] : [])], mode, reconnect: { enabled: false } }
  const rows = [
    ...['computer', 'prompt', 'tools', 'llm', 'sessions', 'agents', 'projections', 'fs', 'subprocess', 'sandbox', 'model'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:attachments', config: { dshHome: root } },
    { name: 'cordis:policy', config: { mode: 'danger-full-access', workspaceRoot: root } },
    ...(runtime ? [{ name: 'cordis:runtime' }] : []),
    { id: 'cua', name: 'cordis:cua', config },
  ]
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'cua')
  if (entry === undefined) throw new Error('Fixture did not load Cua Driver entry')
  if (!failure && runtime && entry.fiber?.state !== FiberState.ACTIVE) throw new AggregateError(errors, 'Cua Driver failed to activate')
  return { ctx, root, model, entry, config, errors }
}

async function events(root: string): Promise<{ event: string; pid: number; name?: string }[]> {
  return (await readFile(join(root, 'driver.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number })
}

function exited(pid: number) { expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })) }

describe('managed Cua Driver', () => {
  it.each(['tools', 'typescript'] as const)('runs a real Agent with durable images through %s and releases all processes', async (mode) => {
    const { ctx, root, entry, model } = await load(mode)
    expect(entry.fiber?.state).toBe(FiberState.ACTIVE)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'tools' ? ['mcp__cua-driver__disconnect', TOOL] : ['run_code'])
    if (mode === 'typescript') {
      expect(renderPrompt(assembly)).toContain(TOOL)
      const direct = await ctx.tools.execute({ name: TOOL, arguments: { display: 0 }, callId: ToolCallId('denied'), signal: new AbortController().signal })
      expect(direct.isError).toBe(true)
      expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    }
    const agent = await ctx.agentLoop.create(SessionId('managed-cua'), { provider: 'fixture', model: 'vision' })
    const idle = new Promise<void>((resolve) => {
      const off = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { off(); resolve() } })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the display.' }], source: { kind: 'user' } }))
    await idle
    expect(model.requests).toHaveLength(2)
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([expect.objectContaining({ name: 'screenshot' })])
    const log = agent.session.snapshotEvents()
    expect(JSON.stringify(log)).not.toContain('iVBORw0KGgo')
    const images = agent.session.deriveMessages().flatMap(message => message.content.filter(block => block.type === 'image'))
    expect(images.length).toBeGreaterThan(0)
    const image = images[0]!
    expect(await ctx.attachments.readImage(image.attachment)).toMatchObject({ ref: { width: 1, height: 1 } })
    await entry.fiber?.dispose()
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    expect(ctx.tools.get('run_code')).toBeUndefined()
    expect(ctx.computerUse.providerName).toBeUndefined()
    for (const event of (await events(root)).filter(event => event.event === 'start')) exited(event.pid)
  })

  it('switches the live Settings mode without replacing the MCP process', async () => {
    const { ctx, entry, config, root } = await load('tools')
    const fiber = entry.fiber
    const before = await events(root)
    for (const mode of ['typescript', 'tools'] as const) {
      await entry.update({ config: { ...config, mode } })
      await entry.fiber?.await()
      expect(entry.fiber === fiber).toBe(true)
      const schemas = (await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)
      expect(schemas.includes(TOOL)).toBe(mode === 'tools')
      expect(schemas.includes('run_code')).toBe(mode === 'typescript')
    }
    expect(await events(root)).toEqual(before)
  })

  it('rolls back the reservation and real child after failed MCP startup', async () => {
    const { ctx, root, entry } = await load('tools', true)
    expect(entry.fiber?.state).toBe(FiberState.FAILED)
    await entry.fiber?.dispose()
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    for (const event of (await events(root)).filter(event => event.event === 'start')) exited(event.pid)
  })

  it.skipIf(process.platform === 'win32')('cancels unfinished executable setup and holds ownership until process exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cua-cancel-')); roots.push(root)
    const command = join(root, 'cua-driver')
    const ready = join(root, 'ready')
    await writeFile(command, `#!${process.execPath}
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid))
`)
    await chmod(command, 0o700)
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(ComputerUse)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const provider = ctx.plugin(Provider, { command, terminationGraceMs: 20 })
    let pid = 0
    await vi.waitFor(async () => { pid = Number(await readFile(ready, 'utf8')); expect(pid).toBeGreaterThan(0) })
    expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
    const stopping = provider.dispose()
    expect(ctx.computerUse.providerName).toBe('cua-driver')
    await stopping
    exited(pid)
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('rejects prompt assembly when TypeScript mode has no runtime', async () => {
    const { ctx, entry } = await load('typescript', false, false)
    expect(entry.fiber?.state).toBe(FiberState.ACTIVE)
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('requires a TypeScript PTC runtime')
  })
})
