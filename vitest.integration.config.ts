import ts from 'typescript'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = process.env.DSH_HARNESS_ROOT
if (!root) throw new Error('Set DSH_HARNESS_ROOT to the prepared Harness checkout; see integration/README.md')
const harness = resolve(root)
const parsed = ts.readConfigFile(resolve(harness, 'tsconfig.base.json'), ts.sys.readFile)
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
const config = parsed.config as {
  compilerOptions: { paths: Record<string, string[]> }
}
const alias = Object.entries(config.compilerOptions.paths).map(([key, paths]) => ({
  find: new RegExp('^' + key.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)') + '$'),
  replacement: resolve(harness, paths[0]!).replace('*', '$1'),
}))
export default defineConfig({
  plugins: [{
    name: 'harness-standard-decorators',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, sourceMap: true },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        ...(result.sourceMapText === undefined ? {} : { map: result.sourceMapText }),
      }
    },
  }],
  resolve: { alias },
  test: { include: ['tests/composition.spec.ts', 'tests/installed-driver.e2e.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
})
