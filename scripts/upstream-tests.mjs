import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const suites = readdirSync('test/upstream-history').filter(n => /\.(test|render|smoke)\.mjs$/.test(n)).map(n => `test/upstream-history/${n}`)
const run = spawnSync(process.execPath, ['--test', ...suites], { stdio: 'inherit', env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'codex-dsh-tests-')) } })
process.exitCode = run.status ?? 1
if (!process.exitCode) {
  const base = 'test/upstream-execution/suites'
  const execution = readdirSync(base).filter(n => n.endsWith('.mjs') && !n.includes('stdio-bridge') && !n.includes('live-e2e')).map(n => `${base}/${n}`)
  execution.push(...readdirSync(`${base}/integration`).filter(n => n.endsWith('.mjs')).map(n => `${base}/integration/${n}`))
  for (const suite of execution) {
    const result = spawnSync(process.execPath, [suite], { stdio: 'inherit', timeout: 30000 })
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
}
