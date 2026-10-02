# dsh-cua-driver

English | [中文](README.zh.md)

An independently maintained [DeepSeek Harness](https://github.com/stevessr/deepseek-harness) plugin for local [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) computer use.

- Finds an executable on PATH, in the official user installation, or at an explicit path.
- Optionally installs or updates the official driver before connecting.
- Reuses Harness's MCP client for discovery, reconnection, canonical results, and screenshots.
- Switches between native MCP tools and **CUA-only TypeScript functions through `run_code`**, without restarting the driver or changing other tools.
- Holds the shared computer-use reservation until startup work and the MCP child finish teardown.

## Compatibility

The supported baseline is **Harness `0.2.0-rc.2`**, Cordis `4.0.4`, and Node `^22.19.0 || >=24`.

| Mode | Stock Harness | With supplied integration patch |
| --- | --- | --- |
| `tools` | Supported | Supported |
| `typescript` | Explicit error; never silently falls back to native tools | Supported; requires `dsh-ptc-runtime-node` |

Stock Harness cannot restrict just one server to programmatic calls. The small, separately maintained [integration patch](integration/README.md) adds that generic capability to `dsh-tools` and `dsh-mcp-client`. **Apply it to the Host's packages, not merely a second copy installed under this plugin.** The plugin does not monkey-patch the Host or change its global presentation mode. No Harness branch is published by this repository.

This repository is not an npm release. Build a local tarball:

```sh
pnpm install
pnpm build
pnpm pack
```

Install the resulting `stevessr-dsh-cua-driver-0.1.0.tgz` in the package root that resolves your Harness composition. Do not install another computer-use provider alongside it.

## Configuration

Add these rows to a profile that already supplies `dsh-tools` and `dsh-system-prompt`. Screenshots require an attachment store and an image-capable model route. Launch applications through a named `dsh` profile.

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- id: cua-driver
  name: '@stevessr/dsh-cua-driver'
  config:
    mode: tools
    command: cua-driver
    autoInstall: false
    autoUpdate: false
```

`mode` is a live Cordis setting exposed by the generic Settings UI. Other fields are deployment configuration: edit the profile/Plugin Manager configuration and reload the entry.

| Setting | Default | Behavior |
| --- | --- | --- |
| `mode` | `tools` | `tools` or `typescript`; live, no reconnect |
| `command` | `cua-driver` | PATH name or **absolute** executable path; explicit paths never fall back |
| `binDir` | Official user bin directory | Additional discovery location and installation target; absolute path required |
| `args` | Driver manifest | MCP argv; e.g. `[mcp, --direct]`; explicit `[]` is different from omission |
| `autoInstall` | `false` | Download and run the official installer if the requested executable is absent |
| `autoUpdate` | `false` | Set the selected channel and run `update --apply --json` before every activation |
| `updateChannel` | `stable` | `stable` or `nightly`; switching back to stable is explicit |
| `setupTimeoutMs` | `300000` | Total executable discovery, installation, update, and manifest deadline |
| `toolCallTimeoutMs` | `60000` | MCP request deadline |
| `maxInstallerBytes` | `1048576` | Downloaded installer byte limit |
| `maxOutputBytes` | `131072` | Retained command output bytes per stream |
| `terminationGraceMs` | `1000` | Local setup-process termination grace |
| `reconnect` | Harness MCP defaults | `enabled`, `initialDelayMs`, `maxDelayMs`, `maxAttempts` |

Discovery tries PATH, the configured/default wrapper directory, then `~/.cua-driver/packages/current`. On Windows the default wrapper directory is `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`; on POSIX it is `~/.local/bin`. Explicit custom executable names cannot be auto-installed. An absolute installation path must end in `cua-driver` (`cua-driver.exe` on Windows).

Omitted `args` requires a valid `manifest --json` with an absolute `mcp_invocation.command` and a string-array `args`. An old or malformed manifest fails; supply explicit arguments for older drivers. Setup failure never silently selects a different driver or falls back after an update failure.

## TypeScript-only mode

Apply the integration patch and compose the TypeScript PTC runtime before using `mode: typescript`. The model receives `run_code` and generated declarations, not native `mcp__cua-driver__*` schemas. Direct dispatch is also denied by the patched executor. Other native tools remain native unless the profile independently selects a global PTC presentation.

For example, the model can pass this program to `run_code` when the installed driver advertises `check_permissions`:

```typescript
const result = await tools["mcp__cua-driver__check_permissions"]({ prompt: false });
return result.structuredContent;
```

Tool names and schemas come from the installed driver, not a fixed DSH action catalog. Successful image-bearing calls attach screenshots after the program. Return only the data you need: returning the complete canonical MCP result can print inline image bytes. Shared `list_mcp_resources`/`read_mcp_resource` tools remain owned by Harness's resource plugin.

## Installation, security, and ownership

Installation and updates are **opt-in**. They execute upstream code and may change the user's existing driver installation or daemon. The plugin downloads only `https://cua.ai/driver/install.sh` or `install.ps1`, bounds the download, writes a private temporary script, and removes it after execution. Setup children run locally with credential-shaped environment variables scrubbed, even if the Host's ordinary subprocess provider is remote.

The POSIX installer receives `--no-modify-path`; Windows receives `-NoPathUpdate -NoAutoStart`. The upstream installer may download additional artifacts and manages their integrity checks. The plugin does not replace upstream release verification, grant desktop permissions, bypass approvals, or install perception extensions. Review the upstream installer before enabling automation.

The plugin owns its MCP processes, **not an already-running Cua daemon or the installed files**. Unloading is not an uninstaller. It cancels and joins unfinished setup, closes the MCP client, withdraws tools, then releases the exclusive `computerUse` slot. MCP reconnects retain that slot. Multiple Sessions and separate Harness processes still share the desktop; coordinate them externally.

## Development and verification

```sh
pnpm typecheck
pnpm test                     # stock-release compatibility and installer unit tests
DSH_HARNESS_ROOT=/path/to/patched/harness pnpm test:integration
```

See [integration setup](integration/README.md). Integration tests load `cordis.yml` through the real Loader, start a stdio MCP fixture, execute a real Agent and Node PTC program, retain screenshot attachments, change the live mode, and assert process exit/ownership cleanup. Fixtures never control the desktop or perform a real installation/update.

Optional read-only compatibility test:

```sh
DSH_HARNESS_ROOT=/path/to/patched/harness \
DSH_COMPUTER_USE_MCP_EXECUTABLE=/absolute/path/to/cua-driver \
DSH_COMPUTER_USE_MCP_ARGS='["mcp","--direct"]' \
pnpm test:live
```

This checks tool discovery and `check_permissions` with `prompt: false`; it does not establish that every desktop action is permitted. Real installer downloads/updates and macOS/Windows runtime behavior require separate platform validation. A full shipped-profile recorded-session replay is not yet part of this standalone test suite.

## Model context effects

Native mode adds the driver's schemas and ordinary results. TypeScript mode replaces those schemas with generated SDK declarations and curated `run_code` output, while preserving durable screenshot context. Unchanged catalogs preserve their prompt prefix; mode changes and driver upgrades can invalidate prefix reuse. Intermediate program values are not model context unless returned or printed.

## License

MIT; see [LICENSE](LICENSE). Cua Driver and any separately installed extensions retain their own licenses.
