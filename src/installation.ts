/** Local executable discovery and opt-in official installation before MCP activation. @module */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { SubprocessExecutableNotFoundError, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Deployment limits and installation choices captured for one activation. */
export interface InstallationConfig {
  /** Absolute executable path or PATH command. */
  command: string
  /** Directory for the official installer's executable wrapper. */
  binDir?: string
  /** Explicit MCP argv; omission uses the driver's manifest. */
  args?: readonly string[]
  /** Run the official installer when discovery finds no executable. */
  autoInstall: boolean
  /** Apply upstream updates before opening an MCP connection. */
  autoUpdate: boolean
  /** Upstream release channel. */
  updateChannel: 'stable' | 'nightly'
  /** Maximum downloaded installer size in bytes. */
  maxInstallerBytes: number
  /** Maximum retained command output per stream in bytes. */
  maxOutputBytes: number
  /** Time allowed for subprocess termination before forced cleanup. */
  terminationGraceMs: number
}

/** Command line ready for the shared MCP client's stdio transport. */
export interface DriverInvocation {
  command: string
  args: string[]
}

/** Platform-owned default wrapper directory, independent of PATH.
 * @returns the absolute user-installation bin directory.
 */
export function defaultBinDir(): string {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Cua', 'cua-driver', 'bin')
    : join(homedir(), '.local', 'bin')
}

/** Installer executable and flags; scripts are files, never interpolated into shell code.
 * @param platform - target operating system.
 * @param script - downloaded private script path.
 * @param channel - selected upstream release channel.
 * @param binDir - absolute wrapper installation directory.
 * @returns the executable and literal argument vector.
 */
export function installerInvocation(platform: NodeJS.Platform, script: string, channel: InstallationConfig['updateChannel'], binDir: string): DriverInvocation {
  return platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', script, '-Channel', channel, '-NoPathUpdate', '-NoAutoStart'] }
    : { command: '/bin/bash', args: [script, '--channel', channel, '--bin-dir', binDir, '--no-modify-path'] }
}

/** Manages activation-time commands through a private local subprocess provider. */
export class DriverInstallation {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: InstallationConfig,
    private readonly signal: AbortSignal,
  ) {}

  /** Resolve a command without substituting another executable for an explicit path.
   * @returns its absolute executable path, or undefined when lookup finds none.
   */
  async detect(): Promise<string | undefined> {
    const { command } = this.config
    const candidates = [command]
    if (command === 'cua-driver') {
      const executable = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
      candidates.push(join(this.config.binDir ?? defaultBinDir(), executable), join(homedir(), '.cua-driver', 'packages', 'current', executable))
    }
    for (const candidate of candidates) {
      try {
        return await this.subprocess.resolveExecutable(candidate, undefined, this.signal)
      } catch (error) {
        if (!(error instanceof SubprocessExecutableNotFoundError)) throw error
      }
    }
    return undefined
  }

  /** Resolve, optionally install/update, and read the exact MCP invocation; failures stop activation.
   * @returns the command and MCP arguments after setup has settled.
   */
  async resolve(): Promise<DriverInvocation> {
    let executable = await this.detect()
    if (executable === undefined && this.config.autoInstall) {
      const expectedName = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
      if (this.config.command !== 'cua-driver' && (!isAbsolute(this.config.command) || basename(this.config.command) !== expectedName)) {
        throw new Error(`Cua Driver cannot auto-install ${JSON.stringify(this.config.command)}; use cua-driver or an absolute path ending in ${expectedName}`)
      }
      const binDir = isAbsolute(this.config.command) ? dirname(this.config.command) : this.config.binDir ?? defaultBinDir()
      await this.install(binDir)
      // Observe the requested install location, never an unrelated executable on PATH.
      executable = await this.subprocess.resolveExecutable(join(binDir, expectedName), undefined, this.signal)
    }
    if (executable === undefined) throw new Error(`Cua Driver executable not found: ${this.config.command}; configure command or enable autoInstall`)
    if (this.config.autoUpdate) {
      await this.run({ command: executable, args: ['channel', 'set', this.config.updateChannel] })
      await this.run({ command: executable, args: ['update', '--apply', '--json'] })
      await this.subprocess.resolveExecutable(executable, undefined, this.signal)
    }
    if (this.config.args !== undefined) return { command: executable, args: [...this.config.args] }
    const manifest: unknown = JSON.parse(await this.run({ command: executable, args: ['manifest', '--json'] }))
    if (typeof manifest !== 'object' || manifest === null || !('mcp_invocation' in manifest)) throw new Error('Cua Driver manifest is missing mcp_invocation; configure args for older drivers')
    const invocation = manifest.mcp_invocation
    if (typeof invocation !== 'object' || invocation === null || !('command' in invocation) || typeof invocation.command !== 'string' || !isAbsolute(invocation.command)
      || !('args' in invocation) || !Array.isArray(invocation.args) || !invocation.args.every((arg: unknown) => typeof arg === 'string')) {
      throw new Error('Cua Driver manifest must declare an absolute mcp_invocation.command and string args')
    }
    return { command: invocation.command, args: invocation.args }
  }

  private async run(invocation: DriverInvocation, env?: NodeJS.ProcessEnv): Promise<string> {
    this.signal.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [invocation.command, ...invocation.args], cwd: homedir(),
      env, signal: this.signal, graceMs: this.config.terminationGraceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } },
    })
    try {
      const outcome = await handle.done
      this.signal.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (outcome.exitCode !== 0) throw new Error(`Cua Driver command ${JSON.stringify(invocation.args)} failed (${String(outcome.exitCode)}): ${stderr?.text ?? ''}`)
      if (stdout?.lossy) throw new Error('Cua Driver command output exceeded maxOutputBytes')
      return stdout?.text ?? ''
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }

  private async install(binDir: string): Promise<void> {
    const windows = process.platform === 'win32'
    const url = `https://cua.ai/driver/install.${windows ? 'ps1' : 'sh'}`
    const response = await fetch(url, { signal: this.signal })
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new Error(`Cua Driver installer download failed: HTTP ${String(response.status)}`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > this.config.maxInstallerBytes) throw new Error('Cua Driver installer exceeded maxInstallerBytes')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    this.signal.throwIfAborted()
    const root = await mkdtemp(join(tmpdir(), 'dsh-cua-install-'))
    try {
      const script = join(root, windows ? 'install.ps1' : 'install.sh')
      await writeFile(script, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 })
      const invocation = installerInvocation(process.platform, script, this.config.updateChannel, binDir)
      await this.run(invocation, { CUA_DRIVER_RS_INSTALL_DIR: binDir })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
