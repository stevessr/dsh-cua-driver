/** Installation tests replace only executable lookup, child execution, and the official download. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, SubprocessExecutableNotFoundError, type SubprocessSpawnSpec, type SubprocessHandle, type SubprocessTerminalHandle, type SubprocessTerminalEnvironment } from '@deepseek-ai/dsh-subprocess'
import { defaultBinDir, DriverInstallation, installerInvocation, type InstallationConfig } from '../src/installation.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

class ProcessFixture extends SubprocessRuntime {
  readonly available = new Set<string>()
  readonly lookups: string[] = []
  readonly calls: SubprocessSpawnSpec[] = []
  joined = 0
  behavior: (spec: SubprocessSpawnSpec) => Promise<{ output?: string; error?: string; exitCode?: number; lossy?: boolean }>
    = async () => ({})
  async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.lookups.push(command)
    if (!this.available.has(command)) throw new SubprocessExecutableNotFoundError(command)
    return isAbsolute(command) ? command : join(defaultBinDir(), command)
  }
  async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { return { platform: 'posix' } }
  async spawnTerminal(): Promise<SubprocessTerminalHandle> { throw new Error('No terminal used by installation') }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    let output = ''; let error = ''; let lossy = false
    const done = this.behavior(spec).then((result) => { output = result.output ?? ''; error = result.error ?? ''; lossy = result.lossy ?? false; return { exitCode: result.exitCode ?? 0, signal: null } })
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: output, nextOffset: output.length, lossy }) },
        stderr: { readFrom: () => ({ text: error, nextOffset: error.length, lossy: false }) },
      },
      done, terminate() {}, waitForExit: async () => { await done; this.joined++; return true },
    }
  }
}

function setup(patch: Partial<InstallationConfig> = {}, signal = new AbortController().signal) {
  const ctx = new Context(); contexts.push(ctx)
  const subprocess = new ProcessFixture(ctx)
  const config: InstallationConfig = { command: 'cua-driver', autoInstall: false, autoUpdate: false, updateChannel: 'stable', maxInstallerBytes: 1024, maxOutputBytes: 4096, terminationGraceMs: 100, ...patch }
  return { subprocess, driver: new DriverInstallation(subprocess, config, signal), signal }
}

const executableName = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'

describe('managed executable preparation', () => {
  it('discovers PATH before standard locations but never falls back from an explicit path', async () => {
    const { driver, subprocess } = setup()
    subprocess.available.add('cua-driver')
    await expect(driver.detect()).resolves.toBe(join(defaultBinDir(), 'cua-driver'))
    expect(subprocess.lookups).toEqual(['cua-driver'])
    subprocess.available.delete('cua-driver')
    subprocess.available.add(join(defaultBinDir(), executableName))
    await expect(driver.detect()).resolves.toBe(join(defaultBinDir(), executableName))
    const explicit = setup({ command: join(defaultBinDir(), 'missing') })
    await expect(explicit.driver.detect()).resolves.toBeUndefined()
    expect(explicit.subprocess.lookups).toEqual([join(defaultBinDir(), 'missing')])
  })

  it('does not install without opt-in or run an unrequested update', async () => {
    const download = vi.spyOn(globalThis, 'fetch')
    const { driver, subprocess } = setup({ args: ['mcp', '--direct'] })
    await expect(driver.resolve()).rejects.toThrow('enable autoInstall')
    expect(download).not.toHaveBeenCalled()
    subprocess.available.add('cua-driver')
    await expect(driver.resolve()).resolves.toEqual({ command: join(defaultBinDir(), 'cua-driver'), args: ['mcp', '--direct'] })
    expect(subprocess.calls).toEqual([])
  })

  it('reads a strict manifest, propagates failure, and joins command ranges', async () => {
    const { driver, subprocess } = setup()
    subprocess.available.add('cua-driver')
    const path = join(defaultBinDir(), executableName)
    subprocess.behavior = async () => ({ output: JSON.stringify({ mcp_invocation: { command: path, args: ['mcp', '--direct'] } }) })
    await expect(driver.resolve()).resolves.toEqual({ command: path, args: ['mcp', '--direct'] })
    expect(subprocess.joined).toBe(1)
    subprocess.behavior = async () => ({ output: '{}' })
    await expect(driver.resolve()).rejects.toThrow('missing mcp_invocation')
    subprocess.behavior = async () => ({ output: JSON.stringify({ mcp_invocation: { command: path, args: [4] } }) })
    await expect(driver.resolve()).rejects.toThrow('string args')
    subprocess.behavior = async () => ({ exitCode: 2, error: 'manifest failure' })
    await expect(driver.resolve()).rejects.toThrow('manifest failure')
    subprocess.behavior = async () => ({ lossy: true })
    await expect(driver.resolve()).rejects.toThrow('maxOutputBytes')
    expect(subprocess.joined).toBe(5)
  })

  it.each(['stable', 'nightly'] as const)('sets the selected %s channel before every update', async (updateChannel) => {
    const { driver, subprocess } = setup({ autoUpdate: true, updateChannel, args: ['mcp'] })
    subprocess.available.add('cua-driver')
    subprocess.available.add(join(defaultBinDir(), 'cua-driver'))
    await driver.resolve()
    expect(subprocess.calls.map(call => call.argv.slice(1))).toEqual([['channel', 'set', updateChannel], ['update', '--apply', '--json']])
    expect(subprocess.joined).toBe(2)
    subprocess.behavior = async () => ({ exitCode: 1 })
    await expect(driver.resolve()).rejects.toThrow('failed')
  })

  it('downloads the official installer into a private temporary file and observes the requested bin directory', async () => {
    const binDir = join(defaultBinDir(), 'test-install-target')
    const { driver, subprocess, signal } = setup({ autoInstall: true, binDir, args: ['mcp'] })
    const download = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# fixture installer'))
    let script = ''
    subprocess.behavior = async (spec) => {
      const index = spec.argv.indexOf('-File')
      script = spec.argv[index < 0 ? 1 : index + 1]!
      expect(await readFile(script, 'utf8')).toBe('# fixture installer')
      expect(spec.env?.CUA_DRIVER_RS_INSTALL_DIR).toBe(binDir)
      subprocess.available.add(join(binDir, executableName))
      return {}
    }
    await expect(driver.resolve()).resolves.toEqual({ command: join(binDir, executableName), args: ['mcp'] })
    expect(download.mock.calls[0]?.[0]).toBe(`https://cua.ai/driver/install.${process.platform === 'win32' ? 'ps1' : 'sh'}`)
    expect(download.mock.calls[0]?.[1]?.signal).toBe(signal)
    await expect(readFile(script)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects oversized downloads and preserves cancellation without starting an installer', async () => {
    const { driver, subprocess } = setup({ autoInstall: true, maxInstallerBytes: 1 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('é'))
    await expect(driver.resolve()).rejects.toThrow('maxInstallerBytes')
    expect(subprocess.calls).toEqual([])
    const abort = new AbortController(); abort.abort(new Error('cancel setup'))
    await expect(setup({}, abort.signal).driver.resolve()).rejects.toThrow('cancel setup')
  })

  it('fails on HTTP and post-install discovery errors instead of substituting a PATH binary', async () => {
    const { driver, subprocess } = setup({ autoInstall: true, args: ['mcp'] })
    const download = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    await expect(driver.resolve()).rejects.toThrow('HTTP 503')
    download.mockResolvedValue(new Response('fixture'))
    await expect(driver.resolve()).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    expect(subprocess.joined).toBe(1)
  })

  it('rejects unsupported auto-install names and keeps installer arguments out of shell code', async () => {
    const { driver } = setup({ command: 'my-driver', autoInstall: true })
    await expect(driver.resolve()).rejects.toThrow('cannot auto-install')
    expect(installerInvocation('linux', '/tmp/a b/install.sh', 'nightly', '/tmp/c d')).toEqual({ command: '/bin/bash', args: ['/tmp/a b/install.sh', '--channel', 'nightly', '--bin-dir', '/tmp/c d', '--no-modify-path'] })
    expect(installerInvocation('win32', 'C:\\a b\\install.ps1', 'stable', 'C:\\bin')).toEqual({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', 'C:\\a b\\install.ps1', '-Channel', 'stable', '-NoPathUpdate', '-NoAutoStart'] })
  })
})
