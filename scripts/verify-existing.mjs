// Re-check a completed live smoke without paying for another model run.
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { createRequire } from 'node:module'

const [workspace, sessionId] = process.argv.slice(2)
if (!workspace || !sessionId) throw new Error('Usage: node scripts/verify-existing.mjs <smoke-workspace> <session-id>')
const sessions = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
let source
for (const item of await readdir(sessions, { withFileTypes: true })) {
  if (!item.isDirectory()) continue
  const children = await readdir(join(sessions, item.name))
  if (children.includes(sessionId)) source = join(sessions, item.name, sessionId, 'session.v4.jsonl.zstd')
}
if (!source) throw new Error('Smoke session log not found')
const data = await readFile(source); let offset = 0; const chunks = []
while (offset < data.length) { const r = zstdDecompressSync(data.subarray(offset), { info: true }); assert.ok(r.engine.bytesWritten > 0); offset += r.engine.bytesWritten; chunks.push(r.buffer) }
const events = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
const ended = events.filter(e => e.type === 'turn/end'); assert.ok(ended.length >= 2)
assert.ok(ended.every(e => e.data.reason.kind === 'completed'))
assert.equal(events.some(e => e.type === 'permission/preset' && e.data.preset === 'danger-full-access'), false)
const testResults = events.filter(e => e.type === 'tool/result').map(e => ({ turn: e.data.turn, text: (e.data.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') }))
assert.ok(testResults.some(r => /tests\s+5/.test(r.text) && /pass\s+5/.test(r.text) && /fail\s+0/.test(r.text)), 'A native DSH tool result must contain five passing tests')
const priorExecutionBlockers = testResults.filter(r => /SetNamedSecurityInfoW|Failed to resolve full path|spawn EPERM/.test(r.text)).length
const result = spawnSync(process.execPath, ['--test', 'normalize.test.cjs'], { cwd: workspace, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stdout + result.stderr)
const require = createRequire(join(workspace, 'independent.cjs')); const { normalizeName } = require(join(workspace, 'normalize.cjs'))
assert.equal(normalizeName('  ＡＢＣ　１２３  '), 'abc-123'); assert.equal(normalizeName('A\tB\nC'), 'a-b-c'); assert.equal(normalizeName('张 三'), '张-三')
assert.deepEqual((await readdir(workspace)).sort(), ['normalize.cjs', 'normalize.test.cjs'])
const state = join(homedir(), '.codex', 'codex-dsh-workspace'); await mkdir(state, { recursive: true })
const report = { success: true, at: new Date().toISOString(), sessionId, workspace, turns: ended.length, dshFinalTestCount: 5, priorExecutionBlockers, independentExitCode: result.status, noFullAccessEscalation: true, independentOutput: result.stdout }
await writeFile(join(state, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ success: true, completedTurns: ended.length, dshFinalTests: 5, priorExecutionBlockers, independentTests: 'passed', noFullAccessEscalation: true }))
