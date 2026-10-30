import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const roots = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'bin', 'lib', 'skills', 'docs', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE', 'third_party']
let checked = 0
function visit(path) {
  const entries = readdirSync(path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const target = join(path, entry.name)
    if (entry.isDirectory()) visit(target)
    else check(target)
  }
}
function check(path) {
  const text = readFileSync(path, 'utf8')
  if (/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+[\\/]|sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}/i.test(text)) throw new Error(`Personal data or credential pattern in ${path}`)
  if (/\.(?:sqlite|jsonl|zstd|log)(?:$|\.)/.test(path)) throw new Error(`Runtime data in package: ${path}`)
  checked++
}
for (const root of roots) {
  try { if (readdirSync('.', { withFileTypes: true }).find(e => e.name === root)?.isDirectory()) visit(root); else check(root) }
  catch (e) { if (e.code === 'ENOENT') continue; throw e }
}
console.error(`Package source audit passed (${checked} files).`)
