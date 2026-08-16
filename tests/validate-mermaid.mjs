/**
 * Validate every ```mermaid block in the repo docs with mermaid.parse().
 * Usage: node tests/validate-mermaid.mjs
 * Exit 0 = every diagram parses.
 *
 * The harness checkout (jsdom/mermaid) and the repo root are resolved from
 * $DSH_HARNESS and $DSH_HOME (defaults: ~/Documents/GitHub/deepseek-harness
 * and ~/.dsh) so the repository carries no personal absolute paths.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const DSH = process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const HARNESS = process.env.DSH_HARNESS
  ? process.env.DSH_HARNESS
  : join(process.env.USERPROFILE || process.env.HOME || '', 'Documents', 'GitHub', 'deepseek-harness')

// Node adaptation for mermaid's browser bundle: dompurify's factory needs a
// real window. jsdom ships inside the harness checkout's dependencies.
const require = createRequire('file:///' + HARNESS.replace(/\\/g, '/') + '/noop.js')
const { JSDOM } = require(join(HARNESS, 'node_modules', 'jsdom'))
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.self = dom.window
try { globalThis.navigator = dom.window.navigator } catch { /* node 22 exposes a getter-only navigator; mermaid tolerates its absence */ }

const mermaid = require(join(HARNESS, 'node_modules', 'mermaid', 'dist', 'mermaid.core.mjs')).default
await mermaid.initialize({ startOnLoad: false })

const root = resolve(join(DSH, 'designs', 'continuity-v3'))
const files = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join('docs', f)), ...readdirSync(join(root, 'docs', 'design')).map((f) => join('docs', 'design', f))]

let passed = 0
let failed = 0
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8')
  const re = /```mermaid\r?\n([\s\S]*?)```/g
  let match
  let index = 0
  while ((match = re.exec(text)) !== null) {
    index += 1
    const code = match[1]
    try {
      // mermaid v11 resolves on success (return value varies by diagram type);
      // any rejection is a parse/render-grammar failure.
      await mermaid.parse(code)
      passed += 1
      console.log('ok  - ' + file + ' #' + index)
    } catch (error) {
      failed += 1
      console.error('FAIL- ' + file + ' #' + index)
      console.error('      ' + String((error && error.message) || error).split('\n').slice(0, 3).join(' | '))
    }
  }
}

console.log('')
console.log('mermaid diagrams: passed ' + passed + ', failed ' + failed)
if (failed > 0) process.exitCode = 1
