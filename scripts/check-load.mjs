// CI on the oldest supported Node: import every hub module the npm package ships, so a
// newer-than-promised API or syntax fails here rather than on someone's machine.
// main.mjs and connect.mjs are left out: importing them starts a hub or a link.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub')
const SKIP = new Set(['main.mjs', 'connect.mjs'])

function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? modules(path.join(dir, d.name))
      : d.name.endsWith('.mjs') && !SKIP.has(d.name) ? [path.join(dir, d.name)] : [])
}

let failed = 0
for (const file of modules(root)) {
  try {
    await import(pathToFileURL(file).href)
  } catch (err) {
    failed++
    console.error(`${path.relative(root, file)}: ${err?.message ?? err}`)
  }
}
console.log(`Node ${process.version}: ${failed ? `${failed} module(s) failed to load` : 'every hub module loads'}`)
process.exitCode = failed ? 1 : 0
