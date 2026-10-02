# Harness integration

The plugin lives in this repository. `harness-programmatic-tools.patch` contains only the generic Host changes necessary for per-server programmatic-only execution, with focused regression tests and API documentation. The patch baseline is pinned in `harness-revision.txt`; do not apply it blindly to another version.

## Prepare an isolated checkout

Use a separate clean clone rather than changing a working checkout with unrelated edits:

```sh
git clone https://github.com/stevessr/deepseek-harness.git .harness
git -C .harness checkout "$(cat integration/harness-revision.txt)"
git -C .harness apply --check ../integration/harness-programmatic-tools.patch
git -C .harness apply ../integration/harness-programmatic-tools.patch
pnpm --dir .harness install
pnpm --dir .harness run build
DSH_HARNESS_ROOT="$PWD/.harness" pnpm test:integration
```

Run Harness applications through its shipped `dsh` profiles. Install the plugin tarball into the resolver package for the chosen profile. Both the Host's tool registry and the MCP bridge imported by the plugin must use the patched packages; an ordinary npm install of a second unpatched `dsh-mcp-client` will not work in TypeScript mode. Native mode needs no patch.

## What the patch changes

- `ToolDefinition.programmaticOnly` omits native schemas and rejects direct execution in every presentation mode.
- Native presentation adds `run_code` only while programmatic-only capabilities are visible, with bindings for those capabilities alone.
- Global PTC/both modes and per-Agent restrictions continue to work; a restricted-away capability is not bound.
- `dsh-mcp-client` forwards a per-server `programmaticOnly` setting without reimplementing MCP discovery or result projection.
- Both packages advertise `supportsProgrammaticOnly`, allowing this external plugin to fail explicitly on unsupported Hosts.

The live getter used by this plugin is read at prompt assembly and dispatch. It does not modify the Host's deployment-wide `tools.mode`.

## Tests

```sh
# Generic executor/MCP regressions in the prepared Host
pnpm --dir .harness exec vitest run packages/core/tools/tests/ptc.spec.ts packages/mcp/mcp-client/tests

# Plugin composition, actual stdio child and Node TypeScript execution
DSH_HARNESS_ROOT="$PWD/.harness" pnpm test:integration
```

`vitest.integration.config.ts` resolves Harness workspace imports to that checkout's source. It does not copy the Harness source into this repository or rely on an implicit sibling path. Build the prepared Host before using its shipped profiles; source tests alone do not validate packaged applications.
